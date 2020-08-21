/**
 * Copyright 2015 CANAL+ Group
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * This file allows to create `AdaptationBuffer`s.
 *
 * An `AdaptationBuffer` downloads and push segment for a single Adaptation
 * (e.g.  a single audio, video or text track).
 * It chooses which Representation to download mainly thanks to the
 * ABRManager, and orchestrates a RepresentationBuffer, which will download and
 * push segments corresponding to a chosen Representation.
 */

import {
  BehaviorSubject,
  concat as observableConcat,
  defer as observableDefer,
  EMPTY,
  merge as observableMerge,
  Observable,
  of as observableOf,
} from "rxjs";
import {
  catchError,
  distinctUntilChanged,
  exhaustMap,
  filter,
  map,
  mergeMap,
  share,
  take,
  tap,
} from "rxjs/operators";
import { formatError } from "../../../errors";
import log from "../../../log";
import Manifest, {
  Adaptation,
  Period,
  Representation,
} from "../../../manifest";
import deferSubscriptions from "../../../utils/defer_subscriptions";
import ABRManager, {
  IABREstimate,
} from "../../abr";
import { SegmentFetcherCreator } from "../../fetchers";
import { QueuedSourceBuffer } from "../../source_buffers";
import EVENTS from "../events_generators";
import RepresentationBuffer, {
  IRepresentationBufferClockTick,
  ITerminationOrder,
} from "../representation";
import {
  IAdaptationBufferEvent,
  IBufferEventAddedSegment,
  IBufferNeedsDiscontinuitySeek,
  IBufferNeedsManifestRefresh,
  IBufferStateActive,
  IBufferStateFull,
  IRepresentationBufferEvent,
} from "../types";
import createRepresentationEstimator from "./create_representation_estimator";

/** `Clock tick` information needed by the AdaptationBuffer. */
export interface IAdaptationBufferClockTick extends IRepresentationBufferClockTick {
  /**
   * For the current SourceBuffer, difference in seconds between the next position
   * where no segment data is available and the current position.
   */
  bufferGap : number;
  /** `duration` property of the HTMLMediaElement on which the content plays. */
  duration : number;
  /** If true, the player has been put on pause. */
  isPaused: boolean;
  /** Last "playback rate" asked by the user. */
  speed : number;
}

/** Arguments given when creating a new `AdaptationBuffer`. */
export interface IAdaptationBufferArguments<T> {
  /**
   * Module allowing to find the best Representation depending on the current
   * conditions like the current network bandwidth.
   */
  abrManager : ABRManager;
  /**
   * Regularly emit playback conditions.
   * The main AdaptationBuffer logic will be triggered on each `tick`.
   */
  clock$ : Observable<IAdaptationBufferClockTick>;
  /** Content you want to create this buffer for. */
  content : { manifest : Manifest;
              period : Period;
              adaptation : Adaptation; };
  /**
   * Strategy taken when the user switch manually the current Representation:
   *   - "seamless": the switch will happen smoothly, with the Representation
   *     with the new bitrate progressively being pushed alongside the old
   *     Representation.
   *   - "direct": hard switch. The Representation switch will be directly
   *     visible but may necessitate the current MediaSource to be reloaded.
   */
  options: { manualBitrateSwitchingMode : "seamless" | "direct" };
  /** SourceBuffer wrapper - needed to push media segments. */
  queuedSourceBuffer : QueuedSourceBuffer<T>;
  /** Module used to fetch the wanted media segments. */
  segmentFetcherCreator : SegmentFetcherCreator<any>;
  /**
   * "Buffer goal" wanted, or the ideal amount of time ahead of the current
   * position in the current SourceBuffer. When this amount has been reached
   * this AdaptationBuffer won't try to download new segments.
   */
  wantedBufferAhead$ : BehaviorSubject<number>;
}

/**
 * Create new AdaptationBuffer Observable, which task will be to download the
 * media data for a given Adaptation (i.e. "track").
 *
 * It will rely on the ABRManager to choose at any time the best Representation
 * for this Adaptation and then run the logic to download and push the
 * corresponding segments in the SourceBuffer.
 *
 * After being subscribed to, it will start running and will emit various events
 * to report its current status.
 *
 * @param {Object} args
 * @returns {Observable}
 */
export default function AdaptationBuffer<T>({
  abrManager,
  clock$,
  content,
  options,
  queuedSourceBuffer,
  segmentFetcherCreator,
  wantedBufferAhead$,
} : IAdaptationBufferArguments<T>) : Observable<IAdaptationBufferEvent<T>> {
  const directManualBitrateSwitching = options.manualBitrateSwitchingMode === "direct";
  const { manifest, period, adaptation } = content;

  /**
   * The buffer goal ratio base itself on the value given by `wantedBufferAhead`
   * to determine a more dynamic buffer goal for a given Representation.
   *
   * It can help in cases such as : the current browser has issues with
   * buffering and tells us that we should try to bufferize less data :
   * https://developers.google.com/web/updates/2017/10/quotaexceedederror
   */
  const bufferGoalRatioMap: Partial<Record<string, number>> = {};

  const { estimator$, requestFeedback$, bufferFeedback$ } =
    createRepresentationEstimator(adaptation, abrManager, clock$);

  /** Allows the `RepresentationBuffer` to easily fetch media segments. */
  const segmentFetcher = segmentFetcherCreator.createSegmentFetcher(adaptation.type,
                                                                    requestFeedback$);

  /**
   * Emits each time an estimation is made through the `abrEstimation$` Observable,
   * starting with the last one.
   * This allows to easily rely on that value in inner Observables which might also
   * need the last already-considered value.
   */
  const lastEstimation$ = new BehaviorSubject<null | IABREstimate>(null);

  /** Emits abr estimations on Subscription. */
  const abrEstimation$ = estimator$.pipe(
    tap((estimation) => { lastEstimation$.next(estimation); }),
    deferSubscriptions(),
    share());

  /** Emit at each bitrate estimation done by the ABRManager. */
  const bitrateEstimation$ = abrEstimation$.pipe(
    filter(({ bitrate }) => bitrate != null),
    distinctUntilChanged((old, current) => old.bitrate === current.bitrate),
    map(({ bitrate }) => {
      log.debug(`Buffer: new ${adaptation.type} bitrate estimation`, bitrate);
      return EVENTS.bitrateEstimationChange(adaptation.type, bitrate);
    })
  );

  /** Recursively create `RepresentationBuffer`s according to the last estimation. */
  const representationBuffers$ = abrEstimation$
      .pipe(exhaustMap((estimation, i) : Observable<IAdaptationBufferEvent<T>> => {
        return recursivelyCreateRepresentationBuffers(estimation, i === 0);
      }));

  return observableMerge(representationBuffers$, bitrateEstimation$);

  /**
   * Create `RepresentationBuffer`s starting with the Representation indicated in
   * `fromEstimation` argument.
   * Each time a new estimation is made, this function will create a new
   * `RepresentationBuffer` corresponding to that new estimation.
   * @param {Object} fromEstimation - The first estimation we should start with
   * @param {boolean} isFirstEstimation - Whether this is the first time we're
   * creating a RepresentationBuffer in the corresponding `AdaptationBuffer`.
   * This is important because manual quality switches might need a full reload
   * of the MediaSource _except_ if we are talking about the first quality chosen.
   * @returns {Observable}
   */
  function recursivelyCreateRepresentationBuffers(
    fromEstimation : IABREstimate,
    isFirstEstimation : boolean
  ) : Observable<IAdaptationBufferEvent<T>> {
    const { representation } = fromEstimation;

    // A manual bitrate switch might need an immediate feedback.
    // To do that properly, we need to reload the MediaSource
    if (directManualBitrateSwitching &&
        fromEstimation.manual &&
        !isFirstEstimation)
    {
      return clock$.pipe(map(t => EVENTS.needsMediaSourceReload(period, t)));
    }

    /**
     * Emit when the current RepresentationBuffer should be terminated to make
     * place for a new one (e.g. when switching quality).
     */
    const terminateCurrentBuffer$ = lastEstimation$.pipe(
      filter((newEstimation) => newEstimation === null ||
                                newEstimation.representation.id !== representation.id ||
                                (newEstimation.manual && !fromEstimation.manual)),
      take(1),
      map((newEstimation) => {
        if (newEstimation === null) {
          log.info("Buffer: urgent Representation termination", adaptation.type);
          return ({ urgent: true });
        }
        if (newEstimation.urgent) {
          log.info("Buffer: urgent Representation switch", adaptation.type);
          return ({ urgent: true });
        } else {
          log.info("Buffer: slow Representation switch", adaptation.type);
          return ({ urgent: false });
        }
      }));

    /**
     * Bitrate higher or equal to this value should not be replaced by segments of
     * better quality.
     * undefined means everything can potentially be replaced
     */
    const knownStableBitrate$ = lastEstimation$.pipe(
      map((estimation) => estimation === null ? undefined :
                                                estimation.knownStableBitrate),
      distinctUntilChanged());

    const representationChange$ =
      observableOf(EVENTS.representationChange(adaptation.type,
                                               period,
                                               representation));

    return observableConcat(representationChange$,
                            createRepresentationBuffer(representation,
                                                       terminateCurrentBuffer$,
                                                       knownStableBitrate$))
    .pipe(
      tap((evt) : void => {
        if (evt.type === "representationChange" ||
            evt.type === "added-segment")
        {
          return bufferFeedback$.next(evt);
        }
      }),
      mergeMap((evt) => {
        if (evt.type === "buffer-terminating") {
          const lastEstimation = lastEstimation$.getValue();
          if (lastEstimation === null) {
            return EMPTY;
          }
          return recursivelyCreateRepresentationBuffers(lastEstimation, false);
        }
        return observableOf(evt);
      }));
  }

  /**
   * Create and returns a new RepresentationBuffer Observable, linked to the
   * given Representation.
   * @param {Representation} representation
   * @returns {Observable}
   */
  function createRepresentationBuffer(
    representation : Representation,
    terminateCurrentBuffer$ : Observable<ITerminationOrder>,
    knownStableBitrate$ : Observable<number | undefined>
  ) : Observable<IRepresentationBufferEvent<T>> {
    return observableDefer(() => {
      const oldBufferGoalRatio = bufferGoalRatioMap[representation.id];
      const bufferGoalRatio = oldBufferGoalRatio != null ? oldBufferGoalRatio :
                                                           1;
      bufferGoalRatioMap[representation.id] = bufferGoalRatio;

      const bufferGoal$ = wantedBufferAhead$.pipe(
        map((wba) => wba * bufferGoalRatio)
      );

      log.info("Buffer: changing representation", adaptation.type, representation);
      return RepresentationBuffer({ clock$,
                                    content: { representation,
                                               adaptation,
                                               period,
                                               manifest },
                                    queuedSourceBuffer,
                                    segmentFetcher,
                                    terminate$: terminateCurrentBuffer$,
                                    bufferGoal$,
                                    knownStableBitrate$ })
        .pipe(catchError((err : unknown) => {
          const formattedError = formatError(err, {
            defaultCode: "NONE",
            defaultReason: "Unknown `RepresentationBuffer` error",
          });
          if (formattedError.code === "BUFFER_FULL_ERROR") {
            const wantedBufferAhead = wantedBufferAhead$.getValue();
            const lastBufferGoalRatio = bufferGoalRatio;
            if (lastBufferGoalRatio <= 0.25 ||
                wantedBufferAhead * lastBufferGoalRatio <= 2)
            {
              throw formattedError;
            }
            bufferGoalRatioMap[representation.id] = lastBufferGoalRatio - 0.25;
            return createRepresentationBuffer(representation,
                                              terminateCurrentBuffer$,
                                              knownStableBitrate$);
          }
          throw formattedError;
        }));
    });
  }
}

// Re-export RepresentationBuffer events used by the AdaptationBuffer
export {
  IBufferEventAddedSegment,
  IBufferNeedsDiscontinuitySeek,
  IBufferNeedsManifestRefresh,
  IBufferStateActive,
  IBufferStateFull,
};

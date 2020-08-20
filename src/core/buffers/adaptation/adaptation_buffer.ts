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
  merge as observableMerge,
  Observable,
  of as observableOf,
  ReplaySubject,
  Subject,
} from "rxjs";
import {
  catchError,
  distinctUntilChanged,
  exhaustMap,
  filter,
  ignoreElements,
  map,
  mergeMap,
  multicast,
  shareReplay,
  skip,
  startWith,
  take,
  tap,
} from "rxjs/operators";
import {
  formatError,
  MediaError,
} from "../../../errors";
import log from "../../../log";
import Manifest, {
  Adaptation,
  Period,
  Representation,
} from "../../../manifest";
import deferSubscriptions from "../../../utils/defer_subscriptions";
import ABRManager, {
  IABREstimate,
  IABRMetric,
  IABRRequest,
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
  IRepresentationChangeEvent,
} from "../types";

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

  /**
   * Emit when the current RepresentationBuffer should be terminated to make
   * place for a new one (e.g. when switching quality).
   */
  const terminateCurrentBuffer$ = new Subject<ITerminationOrder>();

  const { estimator$,
          requestsEvents$,
          bufferEvents$ } = createRepresentationEstimator(adaptation, abrManager, clock$);

  /** Allows the `RepresentationBuffer` to easily fetch media segments. */
  const segmentFetcher = segmentFetcherCreator.createSegmentFetcher(adaptation.type,
                                                                    requestsEvents$);

  /** Emits the last estimation on Subscription. */
  const lastEstimation$ = estimator$.pipe(deferSubscriptions(), shareReplay(1));

  /**
   * Observable used to anounce to the current `RepresentationBuffer` it should
   * terminate to let its place to the next `RepresentationBuffer`.
   */
  const switchQuality$ = lastEstimation$.pipe(
    distinctUntilChanged((a, b) => a.manual === b.manual &&
                                   a.representation.id === b.representation.id),
    skip(1), // Skip initial decision
    tap((estimation) => {
      if (estimation.urgent) {
        log.info("Buffer: urgent Representation switch", adaptation.type);
        terminateCurrentBuffer$.next({ urgent: true });
      } else {
        log.info("Buffer: slow Representation switch", adaptation.type);
        terminateCurrentBuffer$.next({ urgent: false });
      }
    }),
    ignoreElements());

  /**
   * Bitrate higher or equal to this value should not be replaced by segments of
   * better quality.
   * undefined means everything can potentially be replaced
   */
  const knownStableBitrate$ = lastEstimation$.pipe(
    map(({ knownStableBitrate }) => knownStableBitrate),
    // always emit the last on subscribe
    multicast(() => new ReplaySubject< number | undefined >(1)),
    startWith(undefined),
    distinctUntilChanged());

  /** Emit at each bitrate estimate done by the ABRManager. */
  const bitrateEstimates$ = lastEstimation$.pipe(
    filter(({ bitrate }) => bitrate != null),
    distinctUntilChanged((old, current) => old.bitrate === current.bitrate),
    map(({ bitrate }) => {
      log.debug(`Buffer: new ${adaptation.type} bitrate estimation`, bitrate);
      return EVENTS.bitrateEstimationChange(adaptation.type, bitrate);
    })
  );

  /** Recursively create `RepresentationBuffer`s according to the last estimation. */
  const representationBuffers$ = lastEstimation$
      .pipe(exhaustMap((estimate, i) : Observable<IAdaptationBufferEvent<T>> => {
        return recursivelyCreateRepresentationBuffers(estimate, i === 0);
      }));

  return observableMerge(representationBuffers$,
                         bitrateEstimates$,
                         switchQuality$);

  function recursivelyCreateRepresentationBuffers(
    estimate : IABREstimate,
    isFirstEstimate : boolean
  ) : Observable<IAdaptationBufferEvent<T>> {
    const { representation } = estimate;

    // A manual bitrate switch might need an immediate feedback.
    // To do that properly, we need to reload the MediaSource
    if (directManualBitrateSwitching &&
        estimate.manual &&
        !isFirstEstimate)
    {
      return clock$.pipe(map(t => EVENTS.needsMediaSourceReload(period, t)));
    }

    const representationChange$ =
      observableOf(EVENTS.representationChange(adaptation.type,
                                               period,
                                               representation));

    return observableConcat(representationChange$,
      createRepresentationBuffer(representation))
    .pipe(
      tap((evt) : void => {
        if (evt.type === "representationChange" ||
            evt.type === "added-segment")
        {
          return bufferEvents$.next(evt);
        }
      }),
      mergeMap((evt) => {
        if (evt.type === "buffer-terminating") {
          return lastEstimation$.pipe(
            take(1),
            mergeMap((newEstimate : IABREstimate) => {
              return recursivelyCreateRepresentationBuffers(newEstimate, false);
            }));
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
    representation : Representation
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
            return createRepresentationBuffer(representation);
          }
          throw formattedError;
        }));
    });
  }
}

function createRepresentationEstimator(
  adaptation : Adaptation,
  abrManager : ABRManager,
  clock$ : Observable<IAdaptationBufferClockTick>
) : { estimator$ : Observable<IABREstimate>;
      bufferEvents$ : Subject<IBufferEventAddedSegment<unknown> |
                              IRepresentationChangeEvent>;
      requestsEvents$ : Subject<IABRMetric | IABRRequest>; }
{
  const bufferEvents$ = new Subject<IBufferEventAddedSegment<unknown> |
                                    IRepresentationChangeEvent>();
  const requestsEvents$ = new Subject<IABRMetric | IABRRequest>();
  const abrEvents$ = observableMerge(bufferEvents$, requestsEvents$);

  /** Representations for which a `RepresentationBuffer` can be created. */
  const playableRepresentations = adaptation.getPlayableRepresentations();
  if (playableRepresentations.length <= 0) {
    const noRepErr = new MediaError("NO_PLAYABLE_REPRESENTATION",
                                    "No Representation in the chosen " +
                                    "Adaptation can be played");
    throw noRepErr;
  }

  const estimator$ : Observable<IABREstimate> =
    abrManager.get$(adaptation.type, playableRepresentations, clock$, abrEvents$);

  return { estimator$,
           bufferEvents$,
           requestsEvents$ };
}

// Re-export RepresentationBuffer events used by the AdaptationBuffer
export {
  IBufferEventAddedSegment,
  IBufferNeedsDiscontinuitySeek,
  IBufferNeedsManifestRefresh,
  IBufferStateActive,
  IBufferStateFull,
};

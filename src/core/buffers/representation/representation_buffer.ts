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
 * This file allows to create RepresentationBuffers.
 *
 * A RepresentationBuffer downloads and push segment for a single
 * Representation (e.g. a single video stream of a given quality).
 * It chooses which segments should be downloaded according to the current
 * position and what is currently buffered.
 */

import {
  combineLatest as observableCombineLatest,
  concat as observableConcat,
  defer as observableDefer,
  EMPTY,
  merge as observableMerge,
  Observable,
  of as observableOf,
  Subject,
} from "rxjs";
import {
  finalize,
  ignoreElements,
  map,
  mapTo,
  mergeMap,
  share,
  startWith,
  take,
  takeUntil,
  withLatestFrom,
} from "rxjs/operators";
import log from "../../../log";
import Manifest, {
  Adaptation,
  ISegment,
  Period,
  Representation,
} from "../../../manifest";
import { ISegmentParserParsedInitSegment, ISegmentParserResponse } from "../../../transports";
import assertUnreachable from "../../../utils/assert_unreachable";
import objectAssign from "../../../utils/object_assign";
import SimpleSet from "../../../utils/simple_set";
import {
  ISegmentQueue,
  ISegmentQueueEvent,
} from "../../fetchers";
import { QueuedSourceBuffer } from "../../source_buffers";
import EVENTS from "../events_generators";
import {
  IBufferEventAddedSegment,
  IBufferManifestMightBeOutOfSync,
  IBufferNeededActions,
  IBufferStateActive,
  IBufferStateFull,
  IBufferWarningEvent,
  IProtectedSegmentEvent,
  IRepresentationBufferEvent,
} from "../types";
import getNeededSegments from "./get_needed_segments";
import getSegmentPriority from "./get_segment_priority";
import getWantedRange from "./get_wanted_range";
import pushInitSegment from "./push_init_segment";
import pushMediaSegment from "./push_media_segment";

// XXX TODO
import { ISegmentQueueItem } from "../../fetchers/segment/segment_fetcher_creator";

// Item emitted by the Buffer's clock$
export interface IRepresentationBufferClockTick {
  /** The current position of the video element, in seconds. */
  currentTime : number;
  /**
   * Difference between the edge of a live content (the position corresponding
   * to the live time).
   * Not set for non-live contents.
   */
  liveGap? : number;
  /** If set to an object, the player is currently stalled. */
  stalled : object | null;
  /**
   * Offset in s to add to currentTime to obtain the position we actually want
   * to download from
   */
  wantedTimeOffset : number;
}

/**
 * Arguments to give to the RepresentationBuffer
 * @see RepresentationBuffer for documentation
 */
export interface IRepresentationBufferArguments<T> {
  clock$ : Observable<IRepresentationBufferClockTick>;
  content: { adaptation : Adaptation;
             manifest : Manifest;
             period : Period;
             representation : Representation; };
  queuedSourceBuffer : QueuedSourceBuffer<T>;
  segmentQueue : ISegmentQueue<T>;
  terminate$ : Observable<void>;
  bufferGoal$ : Observable<number>;
  knownStableBitrate$: Observable< undefined | number>;
}

/**
 * Build up buffer for a single Representation.
 *
 * Download and push segments linked to the given Representation according
 * to what is already in the SourceBuffer and where the playback currently is.
 *
 * Multiple RepresentationBuffer observables can run on the same SourceBuffer.
 * This allows for example smooth transitions between multiple periods.
 *
 * @param {Object} args
 * @returns {Observable}
 */
export default function RepresentationBuffer<T>({
  bufferGoal$, // emit the buffer size we have to reach
  clock$, // emit current playback information regularly
  content, // The content we want to play
  knownStableBitrate$, // Bitrate higher or equal to this value should not be
                      // replaced by segments of better quality
  queuedSourceBuffer, // interface to the SourceBuffer
  segmentQueue, // allows to download new segments
  terminate$, // signal the RepresentationBuffer that it should terminate
} : IRepresentationBufferArguments<T>) : Observable<IRepresentationBufferEvent<T>> {
  const { period, adaptation, representation } = content;
  const bufferType = adaptation.type;
  const initSegment = representation.index.getInitSegment();

  // Saved initSegment state for this representation.
  let initSegmentObject : ISegmentParserParsedInitSegment<T>|null =
    initSegment == null ? { initializationData: null,
                            segmentProtections: [],
                            initTimescale: undefined } :
                          null;

  /** Immediately checks the buffer's status when it emits. */
  const reCheckStatus$ = new Subject<void>();

  /**
   * Emit when we should stop regularly checking for the current buffer's status.
   * This is used to properly complete when `terminate$` emits.
   */
  const stopStatusCheck$ = new Subject<void>();

  /**
   * Keep track of downloaded segments currently awaiting to be appended to the
   * QueuedSourceBuffer.
   * Used to avoid re-downloading segment that are in the process of being pushed.
   */
  const loadedSegmentPendingPush = new SimpleSet();

  const status$ = observableCombineLatest([
    clock$,
    bufferGoal$,
    terminate$.pipe(take(1),
                    mapTo(true),
                    startWith(false)),
    reCheckStatus$.pipe(startWith(undefined)) ]
  ).pipe(
    takeUntil(stopStatusCheck$),
    withLatestFrom(knownStableBitrate$),
    map(function getCurrentStatus(
      [ [ timing, bufferGoal, terminate ],
        knownStableBitrate ]
    ) : { discontinuity : number;
          isFull : boolean;
          terminate : boolean;
          neededSegments : ISegmentQueueItem[];
          shouldRefreshManifest : boolean; }
    {
      queuedSourceBuffer.synchronizeInventory();
      const neededRange = getWantedRange(period, timing, bufferGoal);

      const discontinuity = timing.stalled !== null ?
        representation.index.checkDiscontinuity(timing.currentTime) :
        -1;

      const shouldRefreshManifest =
        representation.index.shouldRefresh(neededRange.start,
                                           neededRange.end);

      const segmentInventory = queuedSourceBuffer.getInventory();
      let neededSegments = getNeededSegments({ content,
                                               currentPlaybackTime: timing.currentTime,
                                               knownStableBitrate,
                                               loadedSegmentPendingPush,
                                               neededRange,
                                               segmentInventory })
        .map((segment) => ({ priority: getSegmentPriority(segment, timing),
                             segment }));

      if (neededSegments.length > 0 && initSegment !== null &&
          initSegmentObject === null)
      {
        // prepend initialization segment
        const initSegmentPriority = neededSegments[0].priority;
        neededSegments = [ { segment: initSegment,
                             priority: initSegmentPriority },
                           ...neededSegments ];
      }

      let isFull : boolean; // True if the current buffer is full and the one
                            // from the next Period can be created
      if (neededSegments.length > 0 || period.end == null) {
        // Either we still have segments to download or the current Period is
        // not yet ended: not full
        isFull = false;
      } else {
        const lastPosition = representation.index.getLastPosition();
        if (lastPosition === undefined) {
          // We do not know the end of this index.
          // If we reached the end of the period, check that all segments are
          // available.
          isFull = neededRange.end >= period.end &&
                   representation.index.isFinished();
        } else if (lastPosition === null) {
          // There is no available segment in the index currently. If the index
          // tells us it has finished generating new segments, we're done.
          isFull = representation.index.isFinished();
        } else {
          // We have a declared end. Check that our range went until the last
          // position available in the index. If that's the case and we're left
          // with no segments after filtering them, it means we already have
          // downloaded the last segments and have nothing left to do: full.
          const endOfRange = period.end != null ? Math.min(period.end,
                                                           lastPosition) :
                                                  lastPosition;
          isFull = neededRange.end >= endOfRange &&
                   representation.index.isFinished();
        }
      }

      return { discontinuity,
               isFull,
               terminate,
               neededSegments,
               shouldRefreshManifest };
    }),

    mergeMap(function handleStatus(status) : Observable<IBufferNeededActions |
                                                        IBufferStateFull |
                                                        IBufferStateActive> {
      const { neededSegments } = status;

      if (status.terminate) {
        segmentQueue.terminate(neededSegments);
        stopStatusCheck$.next();
        stopStatusCheck$.complete();
        return EMPTY;
      }

      segmentQueue.update(neededSegments);

      const neededActions : IBufferNeededActions[] = [];
      if (status.discontinuity > 1) {
        const nextTime = status.discontinuity + 1;
        const gap: [number, number] = [status.discontinuity, nextTime];
        neededActions.push(EVENTS.discontinuityEncountered(gap,
                                                           bufferType));
      }
      if (status.shouldRefreshManifest) {
        neededActions.push(EVENTS.needsManifestRefresh());
      }

      const currentBufferStatus$ =
        neededSegments.length > 0 ? observableOf(EVENTS.activeBuffer(bufferType)) :
        status.isFull             ? observableOf(EVENTS.fullBuffer(bufferType)) :
                                    EMPTY;
      return observableConcat(observableOf(...neededActions),
                              currentBufferStatus$);
    }));

  const bufferQueue$ = segmentQueue.start()
    .pipe(mergeMap(onSegmentQueueEvent));

  return observableMerge(status$, bufferQueue$).pipe(share());

  /**
   * React to events from the SegmentQueue.
   * @param {Object} evt
   * @returns {Observable}
   */
  function onSegmentQueueEvent(
    evt : ISegmentQueueEvent<T>
  ) : Observable<IBufferEventAddedSegment<T> |
                 IBufferWarningEvent |
                 IProtectedSegmentEvent |
                 IBufferManifestMightBeOutOfSync>
  {
    switch (evt.type) {

      case "retry":
        return observableConcat(
          observableOf(EVENTS.warning(evt.value.error)),
          observableDefer(() => { // better if done after warning is emitted
            const retriedSegment = evt.value.segment;
            const { index } = representation;
            if (index.isSegmentStillAvailable(retriedSegment) === false) {
              reCheckStatus$.next(); // Re-check list of needed segments
            } else if (index.canBeOutOfSyncError(evt.value.error, retriedSegment)) {
              return observableOf(EVENTS.manifestMightBeOufOfSync());
            }
            return EMPTY; // else, ignore.
          }));

      case "chunk": {
        const initTimescale = initSegmentObject?.initTimescale;
        const { segment, parse } = evt.value;
        return parse(initTimescale).pipe(
          mergeMap((parserEvt) => onParsedSegment(segment, parserEvt)));
      }

      case "chunk-complete": {
        const { segment } = evt.value;
        loadedSegmentPendingPush.add(segment.id);
        return queuedSourceBuffer.endOfSegment(objectAssign({ segment }, content))
          .pipe(
            ignoreElements(),
            finalize(() => { // remove from queue
              loadedSegmentPendingPush.remove(segment.id);
            }));
      }

      case "interrupted": {
        const { segment } = evt.value;
        log.info("Buffer: segment request interrupted temporarly.", segment);
        return EMPTY;
      }

      case "empty":
        reCheckStatus$.next(); // The SegmentQueue is empty, re-fill it
        return EMPTY;

      default:
        assertUnreachable(evt);
    }
  }

  /**
   * Logic ran when a new segment has been parsed.
   * @param {Object} segment
   * @param {Object} parsed
   * @returns {Observable}
   */
  function onParsedSegment(
    segment : ISegment,
    parsed : ISegmentParserResponse<T>
  ) : Observable<IBufferEventAddedSegment<T> | IProtectedSegmentEvent> {
    switch (parsed.type) {
      case "parsed-init-segment":
        initSegmentObject = parsed.value;
        const protectedEvents$ = observableOf(
          ...parsed.value.segmentProtections.map(segmentProt => {
            return EVENTS.protectedSegment(segmentProt);
          }));
        const segmentData = parsed.value.initializationData;
        const pushEvent$ = pushInitSegment({ clock$,
                                             content,
                                             segment,
                                             segmentData,
                                             queuedSourceBuffer });
        return observableMerge(protectedEvents$, pushEvent$);

      case "parsed-segment":
        const initSegmentData = initSegmentObject?.initializationData ?? null;
        return pushMediaSegment({ clock$,
                                  content,
                                  initSegmentData,
                                  parsedSegment: parsed.value,
                                  segment,
                                  queuedSourceBuffer });
      default:
        assertUnreachable(parsed);
    }
  }
}

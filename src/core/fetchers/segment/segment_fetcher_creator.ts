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

import {
  defer as observableDefer,
  EMPTY,
  merge as observableMerge,
  Observable,
  of as observableOf,
  Subject,
} from "rxjs";
import {
  mergeMap,
  share,
  startWith,
  takeUntil,
} from "rxjs/operators";
import { ICustomError } from "../../../errors";
import log from "../../../log";
import Manifest, {
  Adaptation,
  ISegment,
  Period,
  Representation,
} from "../../../manifest";
import { ISegmentParserResponse, ITransportPipelines } from "../../../transports";
import assertUnreachable from "../../../utils/assert_unreachable";
import objectAssign from "../../../utils/object_assign";
import {
  IABRMetric,
  IABRRequest,
} from "../../abr";
import getSegmentBackoffOptions from "./get_segment_backoff_options";
import createSegmentFetcher from "./segment_fetcher";

import applyPrioritizerToSegmentFetcher, { IPrioritizedSegmentFetcherEvent } from "./prioritized_segment_fetcher";
import ObservablePrioritizer from "./prioritizer";

/** Options used by the `SegmentsFetcher`. */
export interface ISegmentFetcherOptions {
  /**
   * Whether the content is played in a low-latency mode.
   * This has an impact on default backoff delays.
   */
  lowLatencyMode : boolean;
  /**
   * Maximum number of time a request on error will be retried.
   * `undefined` to just set the default value.
   */
  maxRetryRegular : number | undefined;
  /**
   * Maximum number of time a request be retried when the user is offline.
   * `undefined` to just set the default value.
   */
  maxRetryOffline : number | undefined;
}

/** Options needed to create a SegmentQueue. */
export interface ISegmentQueueContext {
  manifest : Manifest;
  adaptation : Adaptation;
  period : Period;
  representation : Representation;
}

/** Single element from a SegmentQueue's queue. */
export interface ISegmentQueueItem {
  /** The segment you want to request. */
  segment : ISegment;
  /**
   * The priority of the segment request (lower number = higher priority).
   * Starting at 0.
   */
  priority : number;
}

/**
 * Event sent when a segment request has been temporarly interrupted due to
 * another segment request with a high priority.
 * The request for that segment will restart (from scratch) when requests with
 * a higher priority are finished.
 */
export interface ISegmentQueueInterruptedEvent { type : "interrupted";
                                                 value : { segment : ISegment }; }

/** Event sent when a segment request is retried due to an error. */
export interface ISegmentQueueRetryEvent { type : "retry";
                                           value : { error : ICustomError;
                                                     segment : ISegment; }; }

/**
 * Event sent when a new "chunk" of the segment is available.
 * A segment can contain n chunk(s) for n >= 0.
 */
export interface ISegmentQueueChunkEvent<T> {
  type : "chunk";
  value : {
    segment : ISegment;
    /** Parse the downloaded chunk. */
    parse : (initTimescale? : number) => Observable<ISegmentParserResponse<T>>;
  };
}

/**
 * Event sent when all "chunk" of the segments have been communicated through
 * `ISegmentQueueChunkEvent` events.
 */
export interface ISegmentQueueChunkCompleteEvent { type: "chunk-complete";
                                                   value : { segment : ISegment }; }

/** Event sent when no element is left on the current segment queue. */
export interface ISegmentQueueEmptyEvent { type : "empty"; }

/** Every events that can be sent from a segment queue. */
export type ISegmentQueueEvent<T> = ISegmentQueueChunkEvent<T> |
                                    ISegmentQueueChunkCompleteEvent |
                                    ISegmentQueueInterruptedEvent |
                                    ISegmentQueueEmptyEvent |
                                    ISegmentQueueRetryEvent;

/**
 * Structure of a `SegmentQueue`, which allows to easily schedule segment
 * requests for a given type of media (audio, video, text...)
 * The type parameter `T` is the type of the parsed segment's data.
 */
export interface ISegmentQueue<T> {
  /** Update the queue of wanted segment. */
  update(queue : ISegmentQueueItem[]) : void;
  /** Start downloading elements from the queue on subscription. */
  start() : Observable<ISegmentQueueEvent<T>>;
  /**
   * End the current queue when pending download/parse operations are all
   * finished.
   * Use this to smoothly end (without aborting current requests) the current
   * SegmentQueue.
   * You will receive an `ISegmentQueueTerminatedEvent` event (through the
   * `start` method) once downloads are finished.
   * Optionnally, you can give a `queue` argument in which case the current
   * queue will be updated just before the termination process begin.
   */
  terminate(queue? : ISegmentQueueItem[]) : void;
}

/**
 * Provide advanced media segment request scheduling for the player.
 *
 * @class SegmentsFetcher
 *
 * @example
 * ```js
 * const segmentsFetcher = SegmentsFetcher(transport, options);
 *
 * // Create Segment Queue with the right context (Manifest, Adaptation...)
 * const segmentQueue = segmentsFetcher.createSegmentQueue(context, requestsEvents$);
 *
 * // Add wanted segments to the queue, with priorities over other - concurrent -
 * // SegmentQueues
 * segmentQueue.update([ { segment: segment1, priority: 1 },
 *                       { segment: segment2, priority: 1 },
 *                       { segment: segment3, priority: 3 } ]);
 *
 * // Start this queue
 * segmentQueue.start()
 *   // Parse downloaded chunks
 *   .pipe(
 *     filter(evt => evt.type === "chunk"),
 *     mergeMap(evt => evt.value.parse());
 *   ).subscribe((res) => console.log("new audio chunk:", res));
 * ```
 */
export default function SegmentsFetcher(
  transport : ITransportPipelines,
  options : ISegmentFetcherOptions
) {
  const prioritizer = new ObservablePrioritizer<any>({
    prioritySteps: { low: 5,
                     high: 20 },
  });
  // const currentSegmentQueues : Array<ISegmentQueue<unknown>> = [];
  // const currentRequests : ISegmentQueueItem[] = [];
  return {
    /**
     * Create a segment fetcher, allowing to easily perform segment requests.
     * @param {string} bufferType
     * @param {Object} options
     * @returns {Object}
     */
    createSegmentQueue<T>(
      context : ISegmentQueueContext,
      requests$ : Subject<IABRMetric | IABRRequest>
    ) : ISegmentQueue<T> {
      const bufferType = context.adaptation.type;
      const backoffOptions = getSegmentBackoffOptions(bufferType, options);
      const segmentFetcher = createSegmentFetcher<T>(context,
                                                     transport,
                                                     requests$,
                                                     backoffOptions);
      const fetcher = applyPrioritizerToSegmentFetcher(prioritizer, segmentFetcher);

      /**
       * Current queue of segments needed.
       * When the first segment in that queue has been loaded, it is removed
       * from this array and the next element is considered.
       */
      let currentQueue : ISegmentQueueItem[] = [];

      /**
       * When `true`, we want to empty the queue at the end of the current
       * request - or directly, if no request is pending.
       */
      let terminating = false;

      /**
       * Allows to manually check the current queue, to see if our current
       * request is still adapted.
       */
      const reCheckQueue$ = new Subject();

      /**
       * Information about the current segment request. `null` if no segment
       * request is pending.
       */
      let pendingTask : {
        /** The requested segment. */
        segment: ISegment;
        /** The priority with which it was requested. */
        priority: number;
        /**
         * If `true` the `fetcher` is currently loading the segment.
         * If `false`, the `fetcher` is waiting for higher-priority requests
         * to finish before starting to load this segment.
         */
        isLoading: boolean;
        /** Observable created through the `fetcher`. */
        obs: Observable<IPrioritizedSegmentFetcherEvent<T>>;
      } | null = null;

      /** Allows to cancel any previously-created downloading queue. */
      const cancelPreviousDownloadQueues$ = new Subject();

      /**
       * Observable returned by the `start` method of the SegmentQueue.
       * Listen to queue updates, load segments and emit events.
       */
      const segmentQueue$ = reCheckQueue$.pipe(
        startWith(null),
        mergeMap(() => {
          if (pendingTask !== null && currentQueue.length > 0 &&
              currentQueue[0].segment.id === pendingTask.segment.id)
          {
            // Still same segment needed, everything that may change is the priority.
            fetcher.updatePriority(pendingTask.obs, currentQueue[0].priority);
            return EMPTY;
          }
          return observableMerge(requestSegmentsInQueue(),

                                 // Note: we want to cancel the previous task
                                 // AFTER adding the request for the new preferred
                                 // segment, so that the latter is considered when
                                 // the `fetcher` makes its next choice.
                                 observableDefer(() => {
                                   cancelPreviousDownloadQueues$.next();
                                 }));
        }),
        share());

      return {
        update(newQueue : ISegmentQueueItem[]) : void {
          currentQueue = newQueue;
          reCheckQueue$.next();
        },

        terminate(_newQueue : ISegmentQueueItem[]) : void {
          terminating = true;
          if (pendingTask === null || !pendingTask.isLoading) {
            reCheckQueue$.next();
          }
        },

        start() : Observable<ISegmentQueueEvent<T>> {
          return segmentQueue$;
        },
      };

      /**
       * Requests all segments in `currentQueue` with the right priority, one
       * after another, starting with the first one.
       * @returns {Observable}
       */
      function requestSegmentsInQueue() : Observable<ISegmentQueueEvent<T>> {
        if (terminating) {
          terminating = false;
          currentQueue = [];
        }
        if (currentQueue.length === 0) {
          return observableOf({ type: "empty" as const });
        }
        const { segment, priority } = currentQueue[0];
        const request$ = fetcher.createRequest(objectAssign({ segment }, context),
                                               priority);
        pendingTask = { segment, priority, isLoading: false, obs: request$ };
        return request$.pipe(mergeMap((evt) : Observable<ISegmentQueueEvent<T>> => {
            switch (evt.type) {
              case "chunk":
                return observableOf({ type: "chunk" as const,
                                      value: { parse: evt.value.parse, segment } });
              case "chunk-complete":
                return observableOf({ type: "chunk-complete" as const,
                                      value: { segment } });
              case "warning":
                return observableOf({ type: "retry" as const,
                                      value: { error: evt.value, segment } });
              case "interrupted":
                if (pendingTask == null) {
                  log.error("SQ: An unknown pending task was interrupted");
                } else {
                  pendingTask.isLoading = false;
                }
                return observableOf({ type: "interrupted" as const,
                                      value: { segment } });
              case "ended":
                currentQueue.unshift();
                return requestSegmentsInQueue();
              default:
                assertUnreachable(evt);
            }
          })).pipe(takeUntil(cancelPreviousDownloadQueues$));
      }
    },
  };
}

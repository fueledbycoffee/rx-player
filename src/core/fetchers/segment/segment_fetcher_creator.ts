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
import config from "../../../config";
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
import applyPrioritizerToSegmentFetcher, {
  IPrioritizedSegmentFetcherEvent,
} from "./prioritized_segment_fetcher";
import ObservablePrioritizer from "./prioritizer";
import createSegmentFetcher from "./segment_fetcher";

const { MIN_CANCELABLE_PRIORITY,
        MAX_HIGH_PRIORITY_LEVEL } = config;

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
  /**
   * Update the queue of wanted segments, from the most wanted to the least
   * wanted.
   *
   * This method can be called at any time, with the new list of wanted segments
   * and their associated priorities.
   * The `SegmentQueue` will immediately consider that new queue by comparing it
   * with the current one and make decisions accordingly.
   *
   * You will need to call `start` before the `SegmentQueue` begin to load any
   * segment from that queue.
   *
   * @example
   * ```js
   * // Signal to the SegmentQueue that we want to sequentially download
   * // three segments, with the third with a lower priority.
   * segmentQueue.update([ { segment: segment1, priority: 1 },
   *                       { segment: segment2, priority: 1 },
   *                       { segment: segment3, priority: 3 } ]);
   * ```
   * @param {Array.<Object>} queue
   */
  update(queue : ISegmentQueueItem[]) : void;
  /**
   * Start downloading segments from the queue on subscription and return events
   * describing the current status.
   *
   * Note that the Observable returned by this method is shared for the whole
   * `SegmentQueue`.
   * This means that we will only "start" the segment queue with the first (of
   * possibly concurrent) subscription.
   * Any subsequent concurrent subscription will just listen to the same events
   * than the first one.
   * If you completely unsubscribe from this Observable the `SegmentQueue` will
   * stop abruptly (without emptying the current queue).
   *
   * The next first (of possibly concurrent) `start` call will re-start the
   * `SegmentQueue` with the last known queue.
   *
   * @example
   * ```js
   * // Begin to download the last set queue.
   * segmentQueue.start().subscribe((evt) => {
   *   // React to the SegmentQueue's events
   *   // ...
   * });
   * ```
   * @returns {Observable}
   */
  start() : Observable<ISegmentQueueEvent<T>>;
  /**
   * Empty the current queue after a possibly-pending segment request is
   * finished.
   * Empty the queue directly if no segment request is pending.
   *
   * You will receive an `ISegmentQueueEmptyEvent` event (through the `start`
   * method) once the queue is empty.
   *
   * Use this to smoothly end (without aborting current requests) the current
   * SegmentQueue.
   * Optionnally, you can provide a `queueItem` argument which corresponds to
   * the segment concerned by the request you want to finish.
   * If the `SegmentQueue` is not currently loading that segment, the queue will
   * be directly emptied.
   *
   * queue will be updated just before the termination process begin.
   * This can be useful to indicate to the `SegmentQueue` that it can just
   * directly stop if the current request is ...
   * Optionnally, you can give a `queue` argument in which case the current
   * queue will be updated just before the termination process begin.
   * This can be useful to indicate to the `SegmentQueue` that it can just
   * directly stop if the current request is ...
   * // XXX TODO
   *
   * To "re-fill" the queue, you can just call `update` at any time after that
   * call.
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
 * const segmentsFetcher = new SegmentsFetcher(transport, options);
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
export default class SegmentsFetcher {
  private _transport : ITransportPipelines;
  private _backoffOptions : ISegmentFetcherOptions;
  private _prioritizer : ObservablePrioritizer<any>;
  constructor(
    transport : ITransportPipelines,
    options : ISegmentFetcherOptions
  ) {
    this._transport = transport;
    this._backoffOptions = options;
    this._prioritizer = new ObservablePrioritizer<any>({
      prioritySteps: { low: MIN_CANCELABLE_PRIORITY,
                       high: MAX_HIGH_PRIORITY_LEVEL },
    });
  }

  /**
   * Create a segment fetcher, allowing to easily perform segment requests.
   * @param {string} bufferType
   * @param {Object} options
   * @returns {Object}
   */
  public createSegmentQueue<T>(
    context : ISegmentQueueContext,
    requests$ : Subject<IABRMetric | IABRRequest>
  ) : ISegmentQueue<T> {
    const bufferType = context.adaptation.type;
    const backoffOptions = getSegmentBackoffOptions(bufferType, this._backoffOptions);
    const segmentFetcher = createSegmentFetcher<T>(context,
                                                   this._transport,
                                                   requests$,
                                                   backoffOptions);
    const fetcher = applyPrioritizerToSegmentFetcher(this._prioritizer, segmentFetcher);

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

    /** Allows to cancel a previously-created downloading queue. */
    let cancelDownloadQueue$ = new Subject();

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
        const cancelPreviousDownloadQueue$ = cancelDownloadQueue$;
        cancelDownloadQueue$ = new Subject();
        return observableMerge(requestSegmentsInQueue(),

                               // Note: we want to cancel the previous task
                               // AFTER adding the request for the new preferred
                               // segment, so that the latter is considered when
                               // `fetcher` makes its next choice.
                               observableDefer(() => {
                                 cancelPreviousDownloadQueue$.next();
                                 cancelPreviousDownloadQueue$.complete();
                                 return EMPTY;
                               })).pipe(takeUntil(cancelDownloadQueue$));
      }),
      share());

    return {
      update(newQueue : ISegmentQueueItem[]) : void {
        terminating = false;
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
      return observableDefer(() => {
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
                pendingTask = null;
                return requestSegmentsInQueue();
              default:
                assertUnreachable(evt);
            }
        }));
      });
    }
  }
}

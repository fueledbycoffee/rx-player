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

import { ISegment } from "../../../manifest";

const MIN_COUNTER_FOR_REQUEST_LOOP = 2;
const TIMEOUT_RESET_REQUEST_LOOP_COUNTER = 60 * 1000;
const MIN_DELAY_SAME_SEGMENT_REQUEST = 5 * 1000;

/** Item kept internally for every requested segment by the RequestLoopDetector. */
interface IRequestCounterItem {
  /**
   * The number of time the corresponding segment has been needed shortly after
   * having been loaded.
   *
   * This counter is re-setted to 0 (more exactly the whole object is removed)
   * after the timer corresponding to `clearingTimer` has elapsed.
   */
  counter : number;
  /**
   * The value of `performance.now` at the time the last request for this
   * segment finished.
   */
  lastLoadedTime : number;
  /**
   * Each time a request for that segment is finished we create a timer after
   * which this item is removed.
   * This value contains the timer'id to easily clear it.
   */
  clearingTimer : number;
}

/**
 * Detect situations where a given segment is requested over and over in a short
 * time interval.
 *
 * This class keeps tracks of the last few requested segments, and alerts when
 * a segment seems to be requested multiple time at a very low interval.
 *
 * /!\ This class repertories segments per id and as such is only valid for a
 * single Representation.
 *
 * /!\ This class only gives an heuristic about a behavior that might be
 * problematic. It should only be treated as a fail-safe mechanism to avoid the
 * RxPlayer to download too much time the same segments over and over - which
 * could lead to a cascade of unwanted behavior (browser issues, CDN alerts...).
 *
 * The fact that some segment is requested in a loop generally indicates another
 * bug in the RxPlayer which should be fixed.
 *
 * @class RequestLoopDetector
 * @example
 * ```js
 * const requestLoopDetector = const new RequestLoopDetector();
 *
 * // Callback called as soon as a segment is needed (before the request)
 * function onNewWantedSegment(segment) {
 *   if (requestLoopDetector.checkOnSegmentNeeded(segment)) {
 *     console.error("The current segment seems to be requested in a loop.");
 *   }
 *   // ...
 * }
 *
 * // Callback called as soon as a segment is loaded (just after the request)
 * function onSegmentLoaded(segment) {
 *   requestLoopDetector.onSegmentLoaded(segment);
 *   // ...
 * }
 * ```
 */
export default class RequestLoopDetector {
  private _requestCounters : Partial<Record<string, IRequestCounterItem>>;
  private _currentLoopingSegment : ISegment[];

  constructor() {
    this._requestCounters = {};
    this._currentLoopingSegment = [];
  }

  public checkOnSegmentNeeded(segment : ISegment) : boolean {
    const item = this._requestCounters[segment.id];
    if (item === undefined) {
      return false;
    }
    const now = performance.now();
    if (now - item.lastLoadedTime < MIN_DELAY_SAME_SEGMENT_REQUEST) {
      item.counter++;
      if (item.counter >= MIN_COUNTER_FOR_REQUEST_LOOP) {
        this._currentLoopingSegment.push(segment);
      }
    }
    return item.counter >= MIN_COUNTER_FOR_REQUEST_LOOP;
  }

  public onSegmentLoaded(segment : ISegment) : void {
    const item = this._requestCounters[segment.id];
    const clearingTimer = this._getClearingTimer(segment);
    if (item !== undefined) {
      item.lastLoadedTime = performance.now();
      clearTimeout(item.clearingTimer);
      item.clearingTimer = clearingTimer;
      return;
    }
    const newItem : IRequestCounterItem = { counter: 0,
                                            lastLoadedTime: performance.now(),
                                            clearingTimer };
    this._requestCounters[segment.id] = newItem;
  }

  public getCurrentLoops() : ISegment[] {
    return this._currentLoopingSegment;
  }

  private _getClearingTimer(segment : ISegment) : number {
    return window.setTimeout(() => {
      delete this._requestCounters[segment.id];
      const indexOfLooping = this._currentLoopingSegment.indexOf(segment);
      if (indexOfLooping >= 0) {
        this._currentLoopingSegment.splice(indexOfLooping, 1);
      }
    }, TIMEOUT_RESET_REQUEST_LOOP_COUNTER);
  }
}

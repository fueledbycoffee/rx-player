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

import assert from "../utils/assert";
import {
  areNearlyEqual,
  getElementsAfter,
  getElementsBefore,
  ITimedData,
  ITimedDataSegment,
  removeElementsBetween,
} from "./utils";

/**
 * Store timed data (e.g., subtitles) with its corresponding time information in
 * a buffer-like manner (e.g. data cannot overlap, the last pushed has
 * priority...).
 * Allows to add, remove and recuperate data at given times.
 * @class TimedDataStore
 */
export default class TimedDataStore<T> {
  private _buffer : Array<ITimedDataSegment<T>>;

  constructor() {
    this._buffer = [];
  }

  /**
   * Get corresponding data for the given time.
   * The response is an object with three properties:
   *   - start {Number}: start time for which the data should be applied.
   *   - end {Number}: end time for which the data should be applied.
   *   - data {*}: The data to apply
   *
   * Note: The data returned here is never mutated.
   * That is, if the ``get`` method returns the same data's reference than a
   * previous ``get`` call, its properties are guaranteed to have the exact same
   * values than before, if you did not mutate it on your side.
   * The inverse is true, if the values are the same than before, the reference
   * will stay the same (this is useful to easily check if the DOM should be
   * updated, for example).
   *
   * @param {Number} time
   * @returns {Object|undefined}
   */
  get(time : number) : ITimedData<T>|undefined {
    const buffer = this._buffer;

    // begins at the end as most of the time the player will ask for the last
    // data
    for (let i = buffer.length - 1; i >= 0; i--) {
      const content = buffer[i].content;
      for (let j = content.length - 1; j >= 0; j--) {
        const data = content[j];
        if (time >= data.start) {
          if (time < data.end) {
            return data;
          } else {
            return undefined;
          }
        }
      }
    }
    return undefined;
  }

  /**
   * Remove some data from a certain range of time.
   * @param {Number} from
   * @param {Number} to
   */
  remove(from : number, _to : number) : void {
    if (__DEV__) {
      assert(from >= 0);
      assert(_to >= 0);
      assert(_to > from);
    }

    const to = Math.max(from, _to);
    const buffer = this._buffer;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i].end > from) {
        // this segment is concerned by the remove
        const startSegment = buffer[i];
        if (startSegment.start >= to) {
          // our segment is strictly after this interval, we have nothing to do
          return;
        }
        if (startSegment.end >= to) {
          // our segment ends after `to`, we have to keep the end of it
          if (from <= startSegment.start) {
            // from -> to only remove the start of startSegment
            startSegment.content = getElementsAfter(startSegment.content, to);
            startSegment.start = to;
          } else {
            // from -> to is in the middle part of startSegment
            const [ segment1,
                    segment2 ] = removeElementsBetween(startSegment,
                                                         from,
                                                         to);
            this._buffer[i] = segment1;
            buffer.splice(i + 1, 0, segment2);
          }
          // No segment can be concerned after this one, we can quit
          return;
        }

        // Else remove all part after `from`
        if (startSegment.start >= from) {
          // all the segment is concerned
          buffer.splice(i, 1);
          i--; // one less element, we have to decrement the loop
        } else {
          // only the end is concerned
          startSegment.content = getElementsBefore(startSegment.content, from);
          startSegment.end = Math.max(from, startSegment.start);
        }
      }
    }
  }

  /**
   * Insert new data in our buffer.
   *
   * @param {Array.<Object>} content - Array of objects with the following
   * properties:
   *   - start {Number}: start time for which the data should be applied.
   *   - end {Number}: end time for which the data should be applied.
   *   - data {*}: The data to apply
   * @param {Number} start - Start time at which this group of data applies.
   * This is different than the start of the first item to display in it, this
   * has more to do with the time at which the _segment_ starts.
   * @param {Number} end - End time at which the this group of data applies.
   * This is different than the end of the last item to display in it, this
   * has more to do with the time at which the _segment_ ends.
   *
   * TODO add securities to ensure that:
   *   - the start of a segment is inferior or equal to the start of the first
   *     item in it
   *   - the end of a segment is superior or equal to the end of the last
   *     item in it
   * If those requirements are not met, we could delete some data when adding
   * a segment before/after. Find a solution.
   */
  insert(content : Array<ITimedData<T>>, start : number, end : number) : void {
    const buffer = this._buffer;
    const segmentToInsert = { start, end, content };

    /**
     * Called when we found the index of the next cue relative to the cue we
     * want to insert (that is a cue starting after its start or at the same
     * time but ending strictly after its end).
     * Will insert the cue at the right place and update the next cue
     * accordingly.
     * @param {number} indexOfNextCue
     */
    function onIndexOfNextCueFound(indexOfNextCue : number) : void {
      const nextCue = buffer[indexOfNextCue];
      if (nextCue === undefined || // no cue
          areNearlyEqual(segmentToInsert.end, nextCue.end)) // samey end
      {
        //   ours:            |AAAAA|
        //   the current one: |BBBBB|
        //   Result:          |AAAAA|
        buffer[indexOfNextCue] = segmentToInsert;
      } else if (nextCue.start >= segmentToInsert.end) {
        // Either
        //   ours:            |AAAAA|
        //   the current one:         |BBBBBB|
        //   Result:          |AAAAA| |BBBBBB|
        // Or:
        //   ours:            |AAAAA|
        //   the current one:       |BBBBBB|
        //   Result:          |AAAAA|BBBBBB|
        // Add ours before
        buffer.splice(indexOfNextCue, 0, segmentToInsert);
      } else {
        // Either
        //   ours:            |AAAAA|
        //   the current one: |BBBBBBBB|
        //   Result:          |AAAAABBB|
        // Or:
        //   ours:            |AAAAA|
        //   the current one:    |BBBBB|
        //   Result:          |AAAAABBB|
        nextCue.content = getElementsAfter(nextCue.content, segmentToInsert.end);
        nextCue.start = segmentToInsert.end;
        buffer.splice(indexOfNextCue, 0, segmentToInsert);
      }
    }

    for (let i = 0; i < buffer.length; i++) {
      let segment = buffer[i];
      if (start < segment.end) {
        if (areNearlyEqual(start, segment.start)) {
          if (areNearlyEqual(end, segment.end)) {
            // exact same segment
            //   ours:            |AAAAA|
            //   the current one: |BBBBB|
            //   Result:          |AAAAA|
            // Which means:
            //   1. replace the current segment with ours
            buffer[i] = segmentToInsert;
            return;
          } else if (end < segment.end) {
            // our segment overlaps with the current one:
            //   ours:            |AAAAA|
            //   the current one: |BBBBBBBB|
            //   Result:          |AAAAABBB|
            // Which means:
            //   1. remove some content at the start of the current one
            //   2. update start of current one
            //   3. add ours before the current one
            segment.content = getElementsAfter(segment.content, end);
            segment.start = end;
            buffer.splice(i, 0, segmentToInsert);
            return;
          }

          // our cue goes beyond the current one:
          //   ours:            |AAAAAAA|
          //   the current one: |BBBB|...
          //   Result:          |AAAAAAA|
          // Here we have to delete any segment which end before ours end,
          // and see about the following one.
          do {
            buffer.splice(i, 1);
            segment = buffer[i];
          } while (segment !== undefined && end > segment.end);
          onIndexOfNextCueFound(i);
          return;
        } else if (start < segment.start) {
          if (end < segment.start) {
            // our segment goes strictly before the current one:
            //   ours:            |AAAAAAA|
            //   the current one:           |BBBB|
            //   Result:          |AAAAAAA| |BBBB|
            // Which means:
            //   - add ours before the current one
            buffer.splice(i, 0, segmentToInsert);
            return;
          } else if (areNearlyEqual(end, segment.start)) {
            // our segment goes just before the current one:
            //   ours:            |AAAAAAA|
            //   the current one:         |BBBB|
            //   Result:          |AAAAAAA|BBBB|
            // Which means:
            //   - update start time of the current one to be sure
            //   - add ours before the current one
            segment.start = end;
            buffer.splice(i, 0, segmentToInsert);
            return;
          } else if (areNearlyEqual(end, segment.end)) {
            //   ours:            |AAAAAAA|
            //   the current one:    |BBBB|
            //   Result:          |AAAAAAA|
            // Replace
            buffer.splice(i, 1, segmentToInsert);
            return;
          } else if (end < segment.end) {
            //   ours:            |AAAAAAA|
            //   the current one:     |BBBBB|
            //   Result:          |AAAAAAABB|
            segment.content = getElementsAfter(segment.content, end);
            segment.start = end;
            buffer.splice(i, 0, segmentToInsert);
            return;
          }

          //   ours:            |AAAAAAA|
          //   the current one:   |BBB|...
          //   Result:          |AAAAAAA|...
          do {
            buffer.splice(i, 1);
            segment = buffer[i];
          } while (segment !== undefined && end > segment.end);
          onIndexOfNextCueFound(i);
          return;
        }
        // else -> start > segment.start

        if (areNearlyEqual(segment.end, end)) {
          //   ours:              |AAAAAA|
          //   the current one: |BBBBBBBB|
          //   Result:          |BBAAAAAA|
          segment.content = getElementsBefore(segment.content, start);
          segment.end = start;
          buffer.splice(i + 1, 0, segmentToInsert);
          return;
        } else if (segment.end > end) {
          //   ours:              |AAAAAA|
          //   the current one: |BBBBBBBBBBB|
          //   Result:          |BBAAAAAABBB|
          const [ segment1,
                  segment2 ] = removeElementsBetween(segment, start, end);
          this._buffer[i] = segment1;
          buffer.splice(i + 1, 0, segmentToInsert);
          buffer.splice(i + 2, 0, segment2);
          return;
        } else {
          //   ours:              |AAAAAA|
          //   the current one: |BBBBB|...
          //   Result:          |BBAAAAAA|...
          segment.content = getElementsBefore(segment.content, start);
          segment.end = start;

          segment = buffer[i + 1];
          while (segment !== undefined && end > segment.end) {
            buffer.splice(i, 1);
            segment = buffer[i];
          }
          onIndexOfNextCueFound(i);
          return;
        }
      }
    }
    // no segment has the end after our current start.
    // These should be the last one
    buffer.push(segmentToInsert);
  }
}

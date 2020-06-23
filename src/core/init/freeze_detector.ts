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

import { Observable } from "rxjs";
import {
  distinctUntilChanged,
  filter,
  map,
} from "rxjs/operators";
import { isPlaybackStuck } from "../../compat";
import config from "../../config";
import log from "../../log";
import Manifest from "../../manifest";
import { getNextRangeGap } from "../../utils/ranges";
import { IInitClockTick } from "./types";

const { BUFFER_DISCONTINUITY_THRESHOLD } = config;

/**
 * Detect when the current playback is "stalled" for an avoidable reason.
 * Example of such reasons could be any of:
 *
 *   - a small discontinuity is encountered around the current time
 *
 *   - We're at the end of a Period which has a discontinuity until the next one
 *
 *   - the stall happens in a place where buffer is available. This might be
 *     a browser issue where a small seek can un-freeze playback.
 *
 * When an avoidable stall has been encountered, the FreezeDetector will emit an
 * event with an advised new position to seek to.
 *
 * @param {Observable.<Object>} clock$
 * @param {Manifest}
 * @returns {Observable.<Object>}
 */
export default function FreezeDetector(
  clock$: Observable<IInitClockTick>,
  manifest: Manifest
) : Observable< [ number, number ] > {
  return clock$.pipe(
    filter(({ stalled }) => stalled !== null),
    map((tick) : [number, number] | undefined => {
      const { buffered, currentTime, currentRange, state, stalled } = tick;
      const nextBufferRangeGap = getNextRangeGap(buffered, currentTime);
      // 1: Is it a browser bug? -> force seek at the same current time
      if (isPlaybackStuck(currentTime,
                          currentRange,
                          state,
                          stalled !== null)
      ) {
        log.warn("Init: After freeze seek", currentTime, currentRange);
        return [currentTime, currentTime];

      // 2. Is it a short discontinuity in buffer ? -> Seek at the beginning of the
      //                                               next range
      //
      // Discontinuity check in case we are close a buffered range but still
      // calculate a stalled state. This is useful for some
      // implementation that might drop an injected segment, or in
      // case of small discontinuity in the content.
      } else if (nextBufferRangeGap < BUFFER_DISCONTINUITY_THRESHOLD) {
        const seekTo = (currentTime + nextBufferRangeGap + 1 / 60);
        return [currentTime, seekTo];
      }

      // 3. Is it a discontinuity between periods ? -> Seek at the beginning of the
      //                                               next period
      const currentPeriod = manifest.getPeriodForTime(currentTime);
      if (currentPeriod != null) {
        const nextPeriod = manifest.getPeriodAfter(currentPeriod);
        if (currentPeriod != null &&
            currentPeriod.end != null &&
            nextPeriod != null &&
            currentTime > (currentPeriod.end - 1) &&
            currentTime <= nextPeriod.start &&
            nextPeriod.start - currentPeriod.end === 0) {
          return [currentPeriod.end, nextPeriod.start];
        }
      }
    }),
    filter((x): x is [number, number] => x !== undefined),
    distinctUntilChanged()
  );
}

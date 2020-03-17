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
  BehaviorSubject,
  concat as observableConcat,
  defer as observableDefer,
  EMPTY,
  merge as observableMerge,
  Observable,
  of as observableOf,
  Subject,
} from "rxjs";
import {
  exhaustMap,
  filter,
  ignoreElements,
  mergeMap,
  share,
  take,
  takeUntil,
  tap,
} from "rxjs/operators";
import log from "../../../log";
import Manifest, {
  LoadedPeriod,
  PartialPeriod,
} from "../../../manifest";
import { fromEvent } from "../../../utils/event_emitter";
import filterMap from "../../../utils/filter_map";
import SortedList from "../../../utils/sorted_list";
import WeakMapMemory from "../../../utils/weak_map_memory";
import ABRManager from "../../abr";
import { SegmentFetcherCreator } from "../../fetchers";
import SourceBuffersStore, {
  IBufferType,
  ITextTrackSourceBufferOptions,
  QueuedSourceBuffer,
} from "../../source_buffers";
import EVENTS from "../events_generators";
import PeriodBuffer, {
  IPeriodBufferClockTick,
} from "../period";
import {
  ICompletedBufferEvent,
  IMultiplePeriodBuffersEvent,
  IPeriodBufferEvent,
} from "../types";
import getBlacklistedRanges from "./get_blacklisted_ranges";
import getPeriodForTime from "./get_period_for_time";
import resolvePartialPeriod from "./resolve_partial_period";

export { IPeriodBufferClockTick };

export interface IConsecutivePeriodBufferArguments {
  abrManager : ABRManager;
  bufferOptions : { manualBitrateSwitchingMode : "seamless" | "direct";
                    textTrackOptions? : ITextTrackSourceBufferOptions;
                    wantedBufferAhead$ : BehaviorSubject<number>; };
  clock$ : Observable<IPeriodBufferClockTick>;
  garbageCollectors : WeakMapMemory<QueuedSourceBuffer<unknown>, Observable<never>>;
  initialTime : number;
  manifest : Manifest;
  segmentFetcherCreator : SegmentFetcherCreator<any>;
  sourceBuffersStore : SourceBuffersStore;
}

/**
 * Handle creation and removal of Buffers for every Periods for a given type.
 *
 * Works by creating consecutive buffers through the
 * `startConsecutivePeriodBuffers` function, and resetting it when the clock
 * goes out of the bounds of these consecutive Periods.
 * @param {string} bufferType
 * @param {object} args - The huge list of requirements to create consecutive
 * PeriodBuffers
 * @returns {Observable}
 */
export default function PeriodBufferCreator(
  bufferType : IBufferType,
  { abrManager,
    bufferOptions,
    clock$,
    garbageCollectors,
    initialTime,
    manifest,
    segmentFetcherCreator,
    sourceBuffersStore } : IConsecutivePeriodBufferArguments
) : Observable<IMultiplePeriodBuffersEvent> {
  const destroyBuffers$ = new Subject<void>();
  const periodList = new SortedList<LoadedPeriod |
                                    PartialPeriod>((a, b) => a.start - b.start);

  // When set to `true`, all the currently active PeriodBuffer will be destroyed
  // and re-created from the new current position if we detect it to be out of
  // their bounds.
  // This is set to false when we're in the process of creating the first
  // PeriodBuffer, to avoid interferences while no PeriodBuffer is available.
  let enableOutOfBoundsCheck = false;

  // Restart the current buffer when the wanted time is in another period
  // than the ones already considered
  const restartBuffersWhenOutOfBounds$ = clock$.pipe(
    filter(({ currentTime, wantedTimeOffset }) => {
      return enableOutOfBoundsCheck &&
             manifest.getPeriodForTime(wantedTimeOffset +
                                         currentTime) !== undefined &&
             isOutOfPeriodList(periodList, wantedTimeOffset + currentTime);
    }),
    tap(({ currentTime, wantedTimeOffset }) => {
      log.info("BO: Current position out of the bounds of the active periods," +
               "re-creating buffers.",
               bufferType,
               currentTime + wantedTimeOffset);
      enableOutOfBoundsCheck = false;
      destroyBuffers$.next();
    }),
    mergeMap(({ currentTime, wantedTimeOffset }) => {
      return startConsecutivePeriodBuffers(currentTime + wantedTimeOffset,
                                           destroyBuffers$);
    })
  );

  const handleDecipherabilityUpdate$ = fromEvent(manifest, "decipherabilityUpdate")
    .pipe(mergeMap((updates) => {
      const sourceBufferStatus = sourceBuffersStore.getStatus(bufferType);
      const hasType = updates.some(update => update.adaptation.type === bufferType);
      if (!hasType || sourceBufferStatus.type !== "initialized") {
        return EMPTY; // no need to stop the current buffers
      }
      const queuedSourceBuffer = sourceBufferStatus.value;
      const rangesToClean = getBlacklistedRanges(queuedSourceBuffer, updates);
      enableOutOfBoundsCheck = false;
      destroyBuffers$.next();
      return observableConcat(
        ...rangesToClean.map(({ start, end }) =>
          queuedSourceBuffer.removeBuffer(start, end).pipe(ignoreElements())),
        clock$.pipe(take(1), mergeMap((lastTick) => {
          return observableConcat(
            observableOf(EVENTS.needsDecipherabilityFlush(lastTick)),
            observableDefer(() => {
              const lastPosition = lastTick.currentTime + lastTick.wantedTimeOffset;
              return startConsecutivePeriodBuffers(lastPosition, destroyBuffers$);
            }));
        })));
    }));

  return observableMerge(restartBuffersWhenOutOfBounds$,
                         handleDecipherabilityUpdate$,
                         startConsecutivePeriodBuffers(initialTime,
                                                       destroyBuffers$));

  /**
   * Create consecutive PeriodBuffers lazily and recursively.
   *
   * It first creates the PeriodBuffer from `fromTime` and - once it has
   * downloaded it to the end - automatically creates the next chronological
   * one.
   * This process repeats until the PeriodBuffer linked to the last Period is
   * full, at which time the `buffer-complete` event will be sent.
   *
   * When a PeriodBuffer becomes active again - after being full - this function
   * will destroy all PeriodBuffer coming after it (from the last chronological
   * one to the first).
   *
   * To clean-up PeriodBuffers, each one of them are also automatically
   * destroyed once the clock anounce a time superior or equal to the end of
   * the concerned Period.
   *
   * A "periodBufferCleared" event is sent each times a PeriodBuffer is
   * destroyed.
   * @param {number} baseTime - The time from which we will start the first
   * needed PeriodBuffer
   * @param {object} args - The huge list of requirements to create consecutive
   * PeriodBuffers
   * @returns {Observable}
   */
  function startConsecutivePeriodBuffers(
    fromTime : number,
    destroy$ : Observable<void>
  ) : Observable<IMultiplePeriodBuffersEvent> {
    const basePeriod = getPeriodForTime(manifest, fromTime);

    periodList.add(basePeriod);

    // Activate checks if not already done, now that at least a single Period is
    // considered
    enableOutOfBoundsCheck = true;

    if (basePeriod.isLoaded) {
      return onPeriodLoaded(basePeriod);
    }
    return resolvePartialPeriod(manifest, basePeriod, fromTime).pipe(
      takeUntil(destroy$.pipe(tap(() => {
        periodList.removeElement(basePeriod);
      }))),
      mergeMap((evt) : Observable<IMultiplePeriodBuffersEvent> => {
        if (evt.type === "needs-loaded-period") {
          return observableOf({ type: "needs-loaded-period" as const,
            value: { type : bufferType,
                     period : evt.value.period }});
        }
        const fromPeriod = evt.value.period;
        periodList.removeElement(basePeriod);
        periodList.add(fromPeriod);
        return onPeriodLoaded(fromPeriod);
      }));

    function onPeriodLoaded(
      fromPeriod : LoadedPeriod
    ) : Observable<IMultiplePeriodBuffersEvent> {
      log.info("BO: Creating new Buffer for", bufferType, fromPeriod);

      // Emits the wanted time of the next Period Buffer when it can be created.
      const fullBuffer$ = new Subject<void>();

      // Emits when the Buffers for the next Periods should be destroyed, if
      // created.
      const destroyNextBuffers$ = new Subject<void>();

      // Emits when the current position goes over the end of the current buffer.
      const endOfCurrentBuffer$ = clock$.pipe(
        filter(({ currentTime, wantedTimeOffset }) =>
          fromPeriod.end != null &&
          (currentTime + wantedTimeOffset) >= fromPeriod.end));

      // Create Period Buffer for the next Period.
      const nextPeriodBuffer$ = fullBuffer$.pipe(exhaustMap(() => {
        const nextPeriod = manifest.getPeriodAfter(fromPeriod);
        if (nextPeriod === null || fromPeriod.end === undefined) {
          return observableOf(EVENTS.bufferComplete(bufferType));
        }
        const nextWantedTime = Math.max(nextPeriod.start, fromPeriod.end);
        return startConsecutivePeriodBuffers(nextWantedTime, destroyNextBuffers$);
      }));

      // Allows to destroy each created Buffer, from the newest to the oldest,
      // once destroy$ emits.
      const destroyAll$ = destroy$.pipe(
        take(1),
        tap(() => {
          // first complete createNextBuffer$ to allow completion of the
          // nextPeriodBuffer$ observable once every further Buffers have been
          // cleared.
          fullBuffer$.complete();

          // emit destruction signal to the next Buffer first
          destroyNextBuffers$.next();
          destroyNextBuffers$.complete(); // we do not need it anymore
        }),
        share() // share side-effects
      );

      // Will emit when the current buffer should be destroyed.
      const killCurrentBuffer$ = observableMerge(endOfCurrentBuffer$, destroyAll$);

      function createPeriodBuffer(
        loadedPeriod : LoadedPeriod
      ) : Observable<IPeriodBufferEvent | ICompletedBufferEvent> {
        return PeriodBuffer({ abrManager,
                              bufferType,
                              clock$,
                              content: { manifest, period: loadedPeriod },
                              garbageCollectors,
                              segmentFetcherCreator,
                              sourceBuffersStore,
                              options: bufferOptions }
        ).pipe(
          filterMap<IPeriodBufferEvent,
                    IPeriodBufferEvent,
                    null>((evt : IPeriodBufferEvent) => {
              switch (evt.type) {
                case "needs-media-source-reload":
                  // Only reload the MediaSource when the more immediately required
                  // Period is the one asking for it
                  const firstPeriod = periodList.head();
                  if (firstPeriod === undefined ||
                    firstPeriod.id !== evt.value.period.id)
                  {
                    return null;
                  }
                  break;
                case "full-buffer":
                  fullBuffer$.next();
                  break;
                case "active-buffer":
                  // current buffer is active, destroy next buffer if created
                  destroyNextBuffers$.next();
                  break;
              }
              return evt;
            }, null),
          share()
        );
      }

      // Buffer for the current Period.
      const currentBuffer$ : Observable<IMultiplePeriodBuffersEvent> =
      observableConcat(
        createPeriodBuffer(fromPeriod).pipe(takeUntil(killCurrentBuffer$)),
        observableOf(EVENTS.periodBufferCleared(bufferType, fromPeriod))
        .pipe(tap(() => {
          log.info("BO: Destroying buffer for", bufferType, fromPeriod);
          periodList.removeElement(fromPeriod);
        }))
      );

      return observableMerge(currentBuffer$,
                             nextPeriodBuffer$,
                             destroyAll$.pipe(ignoreElements()));
    }
  }
}

/**
 * Returns true if the given time is either:
 *   - less than the start of the chronologically first Period
 *   - more than the end of the chronologically last Period
 * @param {number} time
 * @returns {boolean}
 */
function isOutOfPeriodList(
  periodList : SortedList< LoadedPeriod | PartialPeriod >,
  time : number
) : boolean {
  const head = periodList.head();
  const last = periodList.last();
  if (head == null || last == null) { // if no period
    return true;
  }
  return head.start > time ||
        (last.end == null ? Infinity :
                            last.end) < time;
}

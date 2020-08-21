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
  merge as observableMerge,
  Observable,
  Subject,
} from "rxjs";
import { MediaError } from "../../../errors";
import { Adaptation } from "../../../manifest";
import ABRManager, {
  IABREstimate,
  IABRManagerClockTick,
  IABRMetric,
  IABRRequest,
} from "../../abr";
import {
  IBufferEventAddedSegment,
  IRepresentationChangeEvent,
} from "../types";

/**
 * Create an "estimator$" Observable which will emit which Representation (from
 * the given `Adaptation`) is the best fit (see `IABREstimate` type definition)
 * corresponding to the current network and playback conditions.
 *
 * This function also returns two subjects that should be used to add feedback
 * helping the estimator to make its choices:
 *
 *   - `requestFeedback$`: Subject through which information about new requests
 *     and network metrics should be emitted.
 *
 *   - `bufferFeedback$`: Subject through which buffer-related events should be
 *      emitted.
 *
 * You can look at the types defined for both of those Subjects to have more
 * information on what data is expected. The idea is to provide as much data as
 * possible so the estimation is as adapted as possible.
 *
 * @param {Object} adaptation
 * @param {Object} abrManager
 * @param {Observable} clock$
 * @returns {Object}
 */
export default function createRepresentationEstimator(
  adaptation : Adaptation,
  abrManager : ABRManager,
  clock$ : Observable<IABRManagerClockTick>
) : { estimator$ : Observable<IABREstimate>;
      bufferFeedback$ : Subject<IBufferEventAddedSegment<unknown> |
                                IRepresentationChangeEvent>;
      requestFeedback$ : Subject<IABRMetric | IABRRequest>; }
{
  const bufferFeedback$ = new Subject<IBufferEventAddedSegment<unknown> |
                                      IRepresentationChangeEvent>();
  const requestFeedback$ = new Subject<IABRMetric | IABRRequest>();
  const abrEvents$ = observableMerge(bufferFeedback$, requestFeedback$);

  /** Representations for which a `RepresentationBuffer` can be created. */
  const playableRepresentations = adaptation.getPlayableRepresentations();
  if (playableRepresentations.length <= 0) {
    const noRepErr = new MediaError("NO_PLAYABLE_REPRESENTATION",
                                    "No Representation in the chosen " +
                                    "Adaptation can be played");
    throw noRepErr;
  }

  const estimator$ = abrManager.get$(adaptation.type,
                                     playableRepresentations,
                                     clock$,
                                     abrEvents$);
  return { estimator$,
           bufferFeedback$,
           requestFeedback$ };
}

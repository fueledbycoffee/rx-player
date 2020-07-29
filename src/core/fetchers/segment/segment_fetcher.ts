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
  concat as observableConcat,
  Observable,
  of as observableOf,
  Subject,
} from "rxjs";
import {
  catchError,
  filter,
  finalize,
  mergeMap,
  tap,
} from "rxjs/operators";
import { formatError } from "../../../errors";
import Manifest, {
  Adaptation,
  ISegment,
  Period,
  Representation,
} from "../../../manifest";
import {
  ISegmentParserResponse,
  ITransportPipelines,
} from "../../../transports";
import arrayIncludes from "../../../utils/array_includes";
import idGenerator from "../../../utils/id_generator";
import InitializationSegmentCache from "../../../utils/initialization_segment_cache";
import objectAssign from "../../../utils/object_assign";
import {
  IABRMetric,
  IABRRequest,
} from "../../abr";
import { IBackoffOptions } from "../utils/try_urls_with_backoff";
import createSegmentLoader, {
  ISegmentLoaderChunk,
  ISegmentLoaderChunkComplete,
  ISegmentLoaderData,
  ISegmentLoaderWarning,
} from "./create_segment_loader";

/**
 * Event sent when the segment request needs to be renewed (e.g. due to an HTTP
 * error).
 */
export type ISegmentFetcherWarning = ISegmentLoaderWarning;

/**
 * Event sent when a new "chunk" of the segment is available.
 * A segment can contain n chunk(s) for n >= 0.
 */
export interface ISegmentFetcherChunkEvent<T> {
  type : "chunk";
  value : {
    /** Parse the downloaded chunk. */
    parse : (initTimescale? : number) => Observable<ISegmentParserResponse<T>>;
  };
}

/**
 * Event sent when all "chunk" of the segments have been communicated through
 * `ISegmentFetcherChunkEvent` events.
 */
export interface ISegmentFetcherChunkCompleteEvent { type: "chunk-complete"; }

/** Event sent by the SegmentFetcher when fetching a segment. */
export type ISegmentFetcherEvent<T> = ISegmentFetcherChunkCompleteEvent |
                                      ISegmentFetcherChunkEvent<T> |
                                      ISegmentFetcherWarning;

export type ISegmentFetcher<T> = (segment : ISegment) =>
                                   Observable<ISegmentFetcherEvent<T>>;

const generateRequestID = idGenerator();

// XXX TODO
/** Options needed to create a SegmentQueue. */
export interface ISegmentFetcherContext {
  manifest : Manifest;
  period : Period;
  adaptation : Adaptation;
  representation : Representation;
}

/**
 * Create a function which will fetch and parse segments.
 * @param {Object} context
 * @param {Object} transport
 * @param {Subject} requests$
 * @param {Object} options
 * @returns {Function}
 */
export default function createSegmentFetcher<T>(
  context : ISegmentFetcherContext,
  transport : ITransportPipelines,
  requests$ : Subject<IABRMetric | IABRRequest>,
  options : IBackoffOptions
) : ISegmentFetcher<T> {
  const bufferType = context.adaptation.type;
  const cache = arrayIncludes(["audio", "video"], bufferType) ?
    new InitializationSegmentCache<any>() :
    undefined;
  const segmentLoader = createSegmentLoader<any>(transport[bufferType].loader,
                                                 cache,
                                                 options);
  const segmentParser = transport[bufferType].parser as any; // deal with it

  /**
   * Fetch a single segment.
   * @param {Object} segment
   * @returns {Observable}
   */
  return function fetchSegment(
    segment : ISegment
  ) : Observable<ISegmentFetcherEvent<T>> {
    const content = objectAssign({ segment }, context);
    const id = generateRequestID();
    let requestBeginSent = false;
    return segmentLoader(content).pipe(
      tap((arg) => {
        switch (arg.type) {
          case "metrics": {
            const { value } = arg;
            const { size, duration } = value; // unwrapping for TS

            // format it for ABR Handling
            if (size != null && duration != null) {
              requests$.next({ type: "metrics",
                              value: { size, duration, content } });
            }
            break;
          }

          case "request": {
            // format it for ABR Handling
            if (segment == null || segment.duration == null) {
              return;
            }
            requestBeginSent = true;
            const duration = segment.duration / segment.timescale;
            const time = segment.time / segment.timescale;
            requests$.next({ type: "requestBegin",
                             value: { duration,
                                      time,
                                      requestTimestamp: performance.now(),
                                      id } });
            break;
          }

          case "progress": {
            const { value } = arg;
            if (value.totalSize != null && value.size < value.totalSize) {
              requests$.next({ type: "progress",
                               value: { duration: value.duration,
                                        size: value.size,
                                        totalSize: value.totalSize,
                                        timestamp: performance.now(),
                                        id } });
            }
            break;
          }
        }
      }),

      finalize(() => {
        if (requestBeginSent) {
          requests$.next({ type: "requestEnd", value: { id } });
        }
      }),

      filter((e) : e is ISegmentLoaderChunk |
                        ISegmentLoaderChunkComplete |
                        ISegmentLoaderData<T> |
                        ISegmentFetcherWarning => {
                          switch (e.type) {
                            case "chunk":
                            case "chunk-complete":
                            case "data":
                              return true;
                            default:
                              return false;
                          }
                        }),

      mergeMap((evt) => {
        if (evt.type === "warning") {
          return observableOf(evt);
        }
        if (evt.type === "chunk-complete") {
          return observableOf({ type: "chunk-complete" as const });
        }

        const isChunked = evt.type === "chunk";
        const { responseData } = evt.value;

        /**
         * Parse the loaded data.
         * @param {Object} [initTimescale]
         * @returns {Observable}
         */
        function parse(initTimescale? : number) : Observable<ISegmentParserResponse<T>> {
          const response = { data: responseData, isChunked };
          /* tslint:disable no-unsafe-any */
          return segmentParser({ response, initTimescale, content })
          /* tslint:enable no-unsafe-any */
          .pipe(catchError((error: unknown) => {
            throw formatError(error, { defaultCode: "PIPELINE_PARSE_ERROR",
                                       defaultReason: "Unknown parsing error" });
          }));
        }

        const data = { type: "chunk" as const, value: { parse } };

        return isChunked ?
          observableOf(data) :
          observableConcat(observableOf(data),
                           observableOf({ type: "chunk-complete" as const }));
      }));
  };
}

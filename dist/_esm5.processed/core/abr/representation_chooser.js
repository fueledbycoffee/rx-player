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
import objectAssign from "object-assign";
import { BehaviorSubject, combineLatest as observableCombineLatest, of as observableOf, Subject, } from "rxjs";
import { map, switchMap, takeUntil, tap, } from "rxjs/operators";
import config from "../../config";
import log from "../../log";
import BandwidthEstimator from "./bandwidth_estimator";
import EWMA from "./ewma";
import filterByBitrate from "./filterByBitrate";
import filterByWidth from "./filterByWidth";
import fromBitrateCeil from "./fromBitrateCeil";
var ABR_REGULAR_FACTOR = config.ABR_REGULAR_FACTOR, ABR_STARVATION_FACTOR = config.ABR_STARVATION_FACTOR, ABR_STARVATION_GAP = config.ABR_STARVATION_GAP, OUT_OF_STARVATION_GAP = config.OUT_OF_STARVATION_GAP;
/**
 * Returns an observable emitting only the representation concerned by the
 * bitrate ceil given.
 * @param {Array.<Representation>} representations
 * @param {number} bitrate
 * @returns {Observable}
 */
function setManualRepresentation(representations, bitrate) {
    var chosenRepresentation = fromBitrateCeil(representations, bitrate) ||
        representations[0];
    return observableOf({
        bitrate: undefined,
        manual: true,
        representation: chosenRepresentation,
    });
}
/**
 * Get the pending request starting with the asked segment position.
 * @param {Object} requests
 * @param {number} position
 * @returns {IRequestInfo|undefined}
 */
function getConcernedRequest(requests, position) {
    var currentRequestIds = Object.keys(requests);
    var len = currentRequestIds.length;
    for (var i = 0; i < len; i++) {
        var request = requests[currentRequestIds[i]];
        // We check that this chunk has a high probability of being the one we want
        if (request != null &&
            Math.abs(request.time - position) < request.duration * 0.3) {
            return request;
        }
    }
}
/**
 * Estimate the __VERY__ recent bandwidth based on a single unfinished request.
 * Useful when the current bandwidth seemed to have fallen quickly.
 *
 * @param {Object} request
 * @returns {number|undefined}
 */
function estimateRequestBandwidth(request) {
    if (request.progress.length < 2) {
        return undefined;
    }
    // try to infer quickly the current bitrate based on the
    // progress events
    var ewma1 = new EWMA(2);
    var progress = request.progress;
    for (var i = 1; i < progress.length; i++) {
        var bytesDownloaded = progress[i].size - progress[i - 1].size;
        var timeElapsed = progress[i].timestamp - progress[i - 1].timestamp;
        var reqBitrate = (bytesDownloaded * 8) / (timeElapsed / 1000);
        ewma1.addSample(timeElapsed / 1000, reqBitrate);
    }
    return ewma1.getEstimate();
}
/**
 * Filter representations given through filters options.
 * @param {Array.<Representation>} representations
 * @param {Object} filters - Filter Object.
 * _Can_ contain each of the following properties:
 *   - bitrate {Number} - max bitrate authorized (included).
 *   - width {Number} - max width authorized (included).
 * @returns {Array.<Representation>}
 */
function getFilteredRepresentations(representations, filters) {
    var _representations = representations;
    if (filters.bitrate != null) {
        _representations = filterByBitrate(_representations, filters.bitrate);
    }
    if (filters.width != null) {
        _representations = filterByWidth(_representations, filters.width);
    }
    return _representations;
}
/**
 * Estimate remaining time for a pending request from a progress event.
 * @param {Object} lastProgressEvent
 * @param {number} bandwidthEstimate
 * @returns {number}
 */
function estimateRemainingTime(lastProgressEvent, bandwidthEstimate) {
    var remainingData = (lastProgressEvent.totalSize - lastProgressEvent.size) * 8;
    return Math.max(remainingData / bandwidthEstimate, 0);
}
/**
 * Check if the request for the most needed segment is too slow.
 * If that's the case, re-calculate the bandwidth urgently based on
 * this single request.
 * @param {Object} requests - Current pending requests.
 * @param {Object} clock - Informations on the current playback.
 * @param {Number} lastEstimatedBitrate - Last bitrate estimation emitted.
 * @returns {Number|undefined}
 */
function estimateStarvationModeBitrate(requests, clock, lastEstimatedBitrate) {
    var nextNeededPosition = clock.currentTime + clock.bufferGap;
    var concernedRequest = getConcernedRequest(requests, nextNeededPosition);
    if (!concernedRequest) {
        return undefined;
    }
    var currentBitrate = clock.bitrate;
    var chunkDuration = concernedRequest.duration;
    var now = performance.now();
    var requestElapsedTime = (now - concernedRequest.requestTimestamp) / 1000;
    var lastProgressEvent = concernedRequest.progress ?
        concernedRequest.progress[concernedRequest.progress.length - 1] :
        null;
    // first, try to do a quick estimate from progress events
    var bandwidthEstimate = estimateRequestBandwidth(concernedRequest);
    if (lastProgressEvent != null && bandwidthEstimate != null) {
        var remainingTime = estimateRemainingTime(lastProgressEvent, bandwidthEstimate) * 1.2;
        // if this remaining time is reliable and is not enough to avoid buffering
        if ((now - lastProgressEvent.timestamp) / 1000 <= remainingTime &&
            remainingTime > (clock.bufferGap / clock.speed)) {
            return bandwidthEstimate;
        }
    }
    if (currentBitrate == null ||
        requestElapsedTime <= ((chunkDuration * 1.5 + 1) / clock.speed)) {
        return undefined;
    }
    // calculate a reduced bitrate from the current one
    var reducedBitrate = currentBitrate * 0.7;
    if (lastEstimatedBitrate == null || reducedBitrate < lastEstimatedBitrate) {
        return reducedBitrate;
    }
}
/**
 * Choose the right representation based on multiple parameters given, such as:
 *   - the current user's bandwidth
 *   - the max bitrate authorized
 *   - the size of the video element
 *   - etc.
 *
 * Those parameters can be set through different subjects and methods.
 * The subjects (undocumented here are):
 *
 *   - manualBitrate$ {Subject}: Set the bitrate manually, if no representation
 *     is found with the given bitrate. An immediately inferior one will be
 *     taken instead. If still, none are found, the representation with the
 *     minimum bitrate will be taken.
 *     Set it to a negative value to go into automatic bitrate mode.
 *
 *   - maxBitrate$ {Subject}: Set the maximum automatic bitrate. If the manual
 *     bitrate is not set / set to a negative value, this will be the maximum
 *     switch-able bitrate. If no representation is found inferior or equal to
 *     this bitrate, the representation with the minimum bitrate will be taken.
 *
 * @class RepresentationChooser
 */
var RepresentationChooser = /** @class */ (function () {
    /**
     * @param {Object} options
     */
    function RepresentationChooser(options) {
        this._dispose$ = new Subject();
        this.manualBitrate$ = new BehaviorSubject(options.manualBitrate != null ?
            options.manualBitrate : -1);
        this.maxAutoBitrate$ = new BehaviorSubject(options.maxAutoBitrate != null ?
            options.maxAutoBitrate : Infinity);
        this.estimator = new BandwidthEstimator();
        this._currentRequests = {};
        this._initialBitrate = options.initialBitrate || 0;
        this._limitWidth$ = options.limitWidth$;
        this._throttle$ = options.throttle$;
    }
    /**
     * @param {Observable} clock$
     * @param {Array.<Object>} representations
     * @returns {Observable}
     */
    RepresentationChooser.prototype.get$ = function (clock$, representations) {
        var _this = this;
        if (!representations.length) {
            throw new Error("ABRManager: no representation choice given");
        }
        if (representations.length === 1) {
            return observableOf({
                bitrate: undefined,
                manual: false,
                representation: representations[0],
            });
        }
        var _a = this, manualBitrate$ = _a.manualBitrate$, maxAutoBitrate$ = _a.maxAutoBitrate$, _initialBitrate = _a._initialBitrate;
        var _deviceEventsArray = [];
        if (this._limitWidth$) {
            _deviceEventsArray.push(this._limitWidth$
                .pipe(map(function (width) { return ({ width: width }); })));
        }
        if (this._throttle$) {
            _deviceEventsArray.push(this._throttle$
                .pipe(map(function (bitrate) { return ({ bitrate: bitrate }); })));
        }
        // Emit restrictions on the pools of available representations to choose
        // from.
        var deviceEvents$ = _deviceEventsArray.length ?
            observableCombineLatest.apply(void 0, _deviceEventsArray).pipe(map(function (args) { return objectAssign.apply(void 0, [{}].concat(args)); })) :
            observableOf({});
        // Store the last client's bitrate generated by our estimation algorithms.
        var lastEstimatedBitrate;
        return manualBitrate$.pipe(switchMap(function (manualBitrate) {
            if (manualBitrate >= 0) {
                // -- MANUAL mode --
                return setManualRepresentation(representations, manualBitrate);
            }
            // -- AUTO mode --
            var inStarvationMode = false; // == buffer gap too low == panic mode
            return observableCombineLatest(clock$, maxAutoBitrate$, deviceEvents$)
                .pipe(map(function (_a) {
                var clock = _a[0], maxAutoBitrate = _a[1], deviceEvents = _a[2];
                var nextBitrate;
                var bandwidthEstimate;
                var bufferGap = clock.bufferGap;
                // check if should get in/out of starvation mode
                if (!inStarvationMode && bufferGap <= ABR_STARVATION_GAP) {
                    log.info("ABR - enter starvation mode.");
                    inStarvationMode = true;
                }
                else if (inStarvationMode && bufferGap >= OUT_OF_STARVATION_GAP) {
                    log.info("ABR - exit starvation mode.");
                    inStarvationMode = false;
                }
                // If in starvation mode, check if a quick new estimate can be done
                // from the last requests.
                // If so, cancel previous estimations and replace it by the new one
                if (inStarvationMode) {
                    bandwidthEstimate = estimateStarvationModeBitrate(_this._currentRequests, clock, lastEstimatedBitrate);
                    if (bandwidthEstimate != null) {
                        log.info("ABR - starvation mode emergency estimate:", bandwidthEstimate);
                        _this.estimator.reset();
                        var currentBitrate = clock.bitrate;
                        nextBitrate = currentBitrate == null ?
                            Math.min(bandwidthEstimate, maxAutoBitrate) :
                            Math.min(bandwidthEstimate, maxAutoBitrate, currentBitrate);
                    }
                }
                // if nextBitrate is not yet defined, do the normal estimation
                if (nextBitrate == null) {
                    bandwidthEstimate = _this.estimator.getEstimate();
                    var nextEstimate = void 0;
                    if (bandwidthEstimate != null) {
                        nextEstimate = inStarvationMode ?
                            bandwidthEstimate * ABR_STARVATION_FACTOR :
                            bandwidthEstimate * ABR_REGULAR_FACTOR;
                    }
                    else if (lastEstimatedBitrate != null) {
                        nextEstimate = inStarvationMode ?
                            lastEstimatedBitrate * ABR_STARVATION_FACTOR :
                            lastEstimatedBitrate * ABR_REGULAR_FACTOR;
                    }
                    else {
                        nextEstimate = _initialBitrate;
                    }
                    nextBitrate = Math.min(nextEstimate, maxAutoBitrate);
                }
                if (clock.speed > 1) {
                    nextBitrate /= clock.speed;
                }
                var _representations = getFilteredRepresentations(representations, deviceEvents);
                return {
                    bitrate: bandwidthEstimate,
                    manual: false,
                    representation: fromBitrateCeil(_representations, nextBitrate) ||
                        representations[0],
                };
            }), tap(function (_a) {
                var bitrate = _a.bitrate;
                if (bitrate != null) {
                    log.debug("ABR - calculated bitrate:", bitrate);
                    lastEstimatedBitrate = bitrate;
                }
            }), takeUntil(_this._dispose$));
        }));
    };
    /**
     * Add a bandwidth estimate by giving:
     *   - the duration of the request, in s
     *   - the size of the request in bytes
     * @param {number} duration
     * @param {number} size
     */
    RepresentationChooser.prototype.addEstimate = function (duration, size) {
        if (duration != null && size != null) {
            this.estimator.addSample(duration, size);
        }
    };
    /**
     * Add informations about a new pending request.
     * This can be useful if the network bandwidth drastically changes to infer
     * a new bandwidth through this single request.
     * @param {string|number} id
     * @param {Object} payload
     */
    RepresentationChooser.prototype.addPendingRequest = function (id, payload) {
        if (this._currentRequests[id]) {
            if (false) {
                throw new Error("ABR: request already added.");
            }
            log.warn("ABR: request already added.");
            return;
        }
        var _a = payload.value, time = _a.time, duration = _a.duration, requestTimestamp = _a.requestTimestamp;
        this._currentRequests[id] = {
            time: time,
            duration: duration,
            requestTimestamp: requestTimestamp,
            progress: [],
        };
    };
    /**
     * Add progress informations to a pending request.
     * Progress objects are a key part to calculate the bandwidth from a single
     * request, in the case the user's bandwidth changes drastically while doing
     * it.
     * @param {string|number} id
     * @param {Object} progress
     */
    RepresentationChooser.prototype.addRequestProgress = function (id, progress) {
        var request = this._currentRequests[id];
        if (!request) {
            if (false) {
                throw new Error("ABR: progress for a request not added");
            }
            log.warn("ABR: progress for a request not added");
            return;
        }
        request.progress.push(progress.value);
    };
    /**
     * Remove a request previously set as pending through the addPendingRequest
     * method.
     * @param {string|number} id
     */
    RepresentationChooser.prototype.removePendingRequest = function (id) {
        if (!this._currentRequests[id]) {
            if (false) {
                throw new Error("ABR: can't remove unknown request");
            }
            log.warn("ABR: can't remove unknown request");
        }
        delete this._currentRequests[id];
    };
    /**
     * Free up the resources used by the RepresentationChooser.
     */
    RepresentationChooser.prototype.dispose = function () {
        this._dispose$.next();
        this.manualBitrate$.complete();
        this.maxAutoBitrate$.complete();
    };
    return RepresentationChooser;
}());
export default RepresentationChooser;
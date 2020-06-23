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

/* tslint:disable no-unsafe-any */

import {
  EMPTY,
  Observable,
  Subject,
  throwError as observableThrow,
} from "rxjs";
import { takeUntil } from "rxjs/operators";
import flatMap from "../../../../utils/flat_map";
import { mockCompat } from "./utils";

const incompatibleMKSAErrorMessage =
  "EncryptedMediaError (INCOMPATIBLE_KEYSYSTEMS) No key system compatible with your wanted configuration has been found in the current browser.";

const defaultKSConfig = [{
  audioCapabilities: [ { contentType: "audio/mp4;codecs=\"mp4a.40.2\"",
                         robustness: undefined },
                       { contentType: "audio/webm;codecs=opus",
                         robustness: undefined } ],
  distinctiveIdentifier: "optional",
  initDataTypes: ["cenc"],
  persistentState: "optional",
  sessionTypes: ["temporary"],
  videoCapabilities: [ { contentType: "video/mp4;codecs=\"avc1.4d401e\"",
                         robustness: undefined },
                       { contentType: "video/mp4;codecs=\"avc1.42e01e\"",
                         robustness: undefined },
                       { contentType: "video/webm;codecs=\"vp8\"",
                         robustness: undefined} ],
}];

const defaultWidevineConfig = (() => {
  const ROBUSTNESSES = [ "HW_SECURE_ALL",
                         "HW_SECURE_DECODE",
                         "HW_SECURE_CRYPTO",
                         "SW_SECURE_DECODE",
                         "SW_SECURE_CRYPTO" ];
  const videoCapabilities = flatMap(ROBUSTNESSES, robustness => {
    return [{ contentType: "video/mp4;codecs=\"avc1.4d401e\"",
              robustness },
            { contentType: "video/mp4;codecs=\"avc1.42e01e\"",
              robustness },
            { contentType: "video/webm;codecs=\"vp8\"",
              robustness } ];
  });
  const audioCapabilities = flatMap(ROBUSTNESSES, robustness => {
    return [{ contentType: "audio/mp4;codecs=\"mp4a.40.2\"",
              robustness },
            { contentType: "audio/webm;codecs=opus",
              robustness } ];
  });
  return defaultKSConfig.map(conf => {
    /* tslint:disable ban */
    return Object.assign({}, conf, { audioCapabilities, videoCapabilities });
    /* tslint:enable ban */
  });
})();
const neverCalledFn = jest.fn();

/**
 * Check that the EMEManager, when called with those arguments, throws
 * directly without any event emitted.
 *
 * If that's the case, resolve with the corresponding error.
 * Else, reject.
 * @param {HTMLMediaElement} mediaElement
 * @param {Array.<Object>} keySystemsConfigs
 * @param {Observable} contentProtections$
 * @returns {Promise}
 */
function testEMEManagerImmediateError(
  EMEManager : any,
  mediaElement : HTMLMediaElement,
  keySystemsConfigs : unknown[],
  contentProtections$ : Observable<unknown>
) : Promise<unknown> {
  return new Promise((res, rej) => {
    EMEManager(mediaElement, keySystemsConfigs, contentProtections$)
      .subscribe(
        (evt : unknown) => {
           const eventStr = JSON.stringify(evt as any);
          rej(new Error("Received an EMEManager event: " + eventStr));
        },
        (err : unknown) => { res(err); },
        () => rej(new Error("EMEManager completed."))
      );
  });
}

/**
 * Check that the given `keySystemsConfigs` lead directly to an
 * `INCOMPATIBLE_KEYSYSTEMS` error.
 * @param {Array.<Object>} keySystemsConfigs
 * @returns {Promise}
 */
async function checkIncompatibleKeySystemsErrorMessage(
  keySystemsConfigs : unknown[]
) : Promise<void> {
  const mediaElement = document.createElement("video");
  const EMEManager = require("../../eme_manager").default;

  const error : any = await testEMEManagerImmediateError(EMEManager,
                                                         mediaElement,
                                                         keySystemsConfigs,
                                                         EMPTY);
  expect(error).not.toBe(null);
  expect(error.message).toEqual(incompatibleMKSAErrorMessage);
  expect(error.name).toEqual("EncryptedMediaError");
  expect(error.code).toEqual("INCOMPATIBLE_KEYSYSTEMS");
}

/* tslint:disable no-unsafe-any */
describe("core - eme - global tests - media key system access", () => {
  // Used to implement every functions that should never be called.

  beforeEach(() => {
    jest.resetModules();
    jest.resetAllMocks();
    jest.mock("../../set_server_certificate", () => ({ __esModule: true,
                                                       default: neverCalledFn }));
  });

  afterEach(() => {
    expect(neverCalledFn).not.toHaveBeenCalled();
  });

  it("should throw if an empty keySystemsConfigs is given", async () => {
    mockCompat();
    await checkIncompatibleKeySystemsErrorMessage([]);
  });

  it("should throw if given a single incompatible keySystemsConfigs", async () => {
    const requestMediaKeySystemAccessSpy = jest.fn(() => observableThrow("nope"));
    mockCompat({ requestMediaKeySystemAccess: requestMediaKeySystemAccessSpy });
    const getLicenseFn = neverCalledFn;
    await checkIncompatibleKeySystemsErrorMessage([{ type: "foo",
                                                     getLicense: getLicenseFn }]);
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledTimes(1);
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledWith("foo", defaultKSConfig);
  });

  it("should throw if given multiple incompatible keySystemsConfigs", async () => {
    const requestMediaKeySystemAccessSpy = jest.fn(() => observableThrow("nope"));
    mockCompat({ requestMediaKeySystemAccess: requestMediaKeySystemAccessSpy });
    const config = [ { type: "foo", getLicense: neverCalledFn },
                     { type: "bar", getLicense: neverCalledFn },
                     { type: "baz", getLicense: neverCalledFn } ];
    await checkIncompatibleKeySystemsErrorMessage(config);
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledTimes(3);
    expect(requestMediaKeySystemAccessSpy)
      .toHaveBeenNthCalledWith(1, "foo", defaultKSConfig);
    expect(requestMediaKeySystemAccessSpy)
      .toHaveBeenNthCalledWith(2, "bar", defaultKSConfig);
    expect(requestMediaKeySystemAccessSpy)
      .toHaveBeenNthCalledWith(3, "baz", defaultKSConfig);
  });

  /* tslint:disable max-line-length */
  it("should throw an error if no implementation of requestMediaKeySystemAccess is set", async () => {
  /* tslint:enable max-line-length */
    mockCompat({ requestMediaKeySystemAccess: undefined });
    const mediaElement = document.createElement("video");
    const EMEManager = require("../../eme_manager").default;

    const config = [{ type: "foo", getLicense: neverCalledFn }];
    const error : any = await testEMEManagerImmediateError(EMEManager,
                                                           mediaElement,
                                                           config,
                                                           EMPTY);
    expect(error).not.toBe(null);
    expect(error.message)
      .toEqual("requestMediaKeySystemAccess is not implemented in your browser.");
  });

  it("should throw if given a single incompatible keySystemsConfigs", async () => {
    const requestMediaKeySystemAccessSpy = jest.fn(() => observableThrow("nope"));
    mockCompat({ requestMediaKeySystemAccess: requestMediaKeySystemAccessSpy });
    await checkIncompatibleKeySystemsErrorMessage([{ type: "foo",
                                                     getLicense: neverCalledFn }]);
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledTimes(1);
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledWith("foo", defaultKSConfig);
  });

  /* tslint:disable max-line-length */
  it("should change persistentState value if persistentStateRequired is set to true", async () => {
  /* tslint:enable max-line-length */
    const requestMediaKeySystemAccessSpy = jest.fn(() => observableThrow("nope"));
    mockCompat({ requestMediaKeySystemAccess: requestMediaKeySystemAccessSpy });
    await checkIncompatibleKeySystemsErrorMessage([{ type: "foo",
                                                     getLicense: neverCalledFn,
                                                     persistentStateRequired: true }]);
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledTimes(1);

    const expectedConfig = defaultKSConfig.map(conf => {
      /* tslint:disable ban */
      return Object.assign({}, conf, { persistentState: "required" });
      /* tslint:enable ban */
    });
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledWith("foo", expectedConfig);
  });

  /* tslint:disable max-line-length */
  it("should not change persistentState value if persistentStateRequired is set to false", async () => {
  /* tslint:enable max-line-length */
    const requestMediaKeySystemAccessSpy = jest.fn(() => observableThrow("nope"));
    mockCompat({ requestMediaKeySystemAccess: requestMediaKeySystemAccessSpy });
    await checkIncompatibleKeySystemsErrorMessage([{ type: "foo",
                                                     getLicense: neverCalledFn,
                                                     persistentStateRequired: false }]);
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledTimes(1);
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledWith("foo", defaultKSConfig);
  });

  /* tslint:disable max-line-length */
  it("should change distinctiveIdentifier value if distinctiveIdentifierRequired is set to true", async () => {
  /* tslint:enable max-line-length */
    const requestMediaKeySystemAccessSpy = jest.fn(() => observableThrow("nope"));
    mockCompat({ requestMediaKeySystemAccess: requestMediaKeySystemAccessSpy });
    await checkIncompatibleKeySystemsErrorMessage([{
      type: "foo",
      getLicense: neverCalledFn,
      distinctiveIdentifierRequired: true,
    }]);
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledTimes(1);

    const expectedConfig = defaultKSConfig.map(conf => {
      /* tslint:disable ban */
      return Object.assign({}, conf, { distinctiveIdentifier: "required" });
      /* tslint:enable ban */
    });
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledWith("foo", expectedConfig);
  });

  /* tslint:disable max-line-length */
  it("should not change distinctiveIdentifier value if distinctiveIdentifierRequired is set to false", async () => {
  /* tslint:enable max-line-length */
    const requestMediaKeySystemAccessSpy = jest.fn(() => observableThrow("nope"));
    mockCompat({ requestMediaKeySystemAccess: requestMediaKeySystemAccessSpy });
    await checkIncompatibleKeySystemsErrorMessage([{
      type: "foo",
      getLicense: neverCalledFn,
      distinctiveIdentifierRequired: false,
    }]);
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledTimes(1);
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledWith("foo", defaultKSConfig);
  });

  it("should do nothing if just licenseStorage is set", async () => {
    const requestMediaKeySystemAccessSpy = jest.fn(() => observableThrow("nope"));
    mockCompat({ requestMediaKeySystemAccess: requestMediaKeySystemAccessSpy });
    const licenseStorage = { save() { throw new Error("Should not save."); },
                             load() { throw new Error("Should not load."); } };
    await checkIncompatibleKeySystemsErrorMessage([{ type: "foo",
                                                     getLicense: neverCalledFn,
                                                     licenseStorage }]);
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledTimes(1);
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledWith("foo", defaultKSConfig);
  });

  /* tslint:disable max-line-length */
  it("should want persistent sessions if both persistentLicense and licenseStorage are set", async () => {
  /* tslint:enable max-line-length */
    const requestMediaKeySystemAccessSpy = jest.fn(() => observableThrow("nope"));
    mockCompat({ requestMediaKeySystemAccess: requestMediaKeySystemAccessSpy });
    const licenseStorage = { save() { throw new Error("Should not save."); },
                             load() { throw new Error("Should not load."); } };
    await checkIncompatibleKeySystemsErrorMessage([{ type: "foo",
                                                     getLicense: neverCalledFn,
                                                     licenseStorage,
                                                     persistentLicense: true }]);
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledTimes(1);

    const expectedConfig = defaultKSConfig.map(conf => {
      /* tslint:disable ban */
      return Object.assign({}, conf, { persistentState: "required",
                                       sessionTypes: ["temporary",
                                                      "persistent-license"] });
      /* tslint:enable ban */
    });
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledWith("foo", expectedConfig);
  });

  /* tslint:disable max-line-length */
  it("should want persistent sessions if just persistentLicense is set to true", async () => {
  /* tslint:enable max-line-length */
    const requestMediaKeySystemAccessSpy = jest.fn(() => observableThrow("nope"));
    mockCompat({ requestMediaKeySystemAccess: requestMediaKeySystemAccessSpy });
    await checkIncompatibleKeySystemsErrorMessage([{ type: "foo",
                                                     getLicense: neverCalledFn,
                                                     persistentLicense: true }]);
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledTimes(1);

    const expectedConfig = defaultKSConfig.map(conf => {
      /* tslint:disable ban */
      return Object.assign({}, conf, { persistentState: "required",
                                       sessionTypes: ["temporary",
                                                      "persistent-license"] });
      /* tslint:enable ban */
    });
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledWith("foo", expectedConfig);
  });

  it("should do nothing if persistentLicense is set to false", async () => {
    const requestMediaKeySystemAccessSpy = jest.fn(() => observableThrow("nope"));
    mockCompat({ requestMediaKeySystemAccess: requestMediaKeySystemAccessSpy });
    await checkIncompatibleKeySystemsErrorMessage([{ type: "foo",
                                                     getLicense: neverCalledFn,
                                                     persistentLicense: false }]);
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledTimes(1);
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledWith("foo", defaultKSConfig);
  });

  it("should translate a `clearkey` keySystem", async () => {
    const requestMediaKeySystemAccessSpy = jest.fn(() => observableThrow("nope"));
    mockCompat({ requestMediaKeySystemAccess: requestMediaKeySystemAccessSpy });
    await checkIncompatibleKeySystemsErrorMessage([{ type: "clearkey",
                                                     getLicense: neverCalledFn }]);
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledTimes(2);
    expect(requestMediaKeySystemAccessSpy)
      .toHaveBeenNthCalledWith(1, "webkit-org.w3.clearkey", defaultKSConfig);
    expect(requestMediaKeySystemAccessSpy)
      .toHaveBeenNthCalledWith(2, "org.w3.clearkey", defaultKSConfig);
  });

  it("should translate a `widevine` keySystem", async () => {
    const requestMediaKeySystemAccessSpy = jest.fn(() => observableThrow("nope"));
    mockCompat({ requestMediaKeySystemAccess: requestMediaKeySystemAccessSpy });
    await checkIncompatibleKeySystemsErrorMessage([{ type: "widevine",
                                                     getLicense: neverCalledFn }]);
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledTimes(1);
    expect(requestMediaKeySystemAccessSpy)
      .toHaveBeenCalledWith("com.widevine.alpha", defaultWidevineConfig);
  });

  it("should translate a `playready` keySystem", async () => {
    const requestMediaKeySystemAccessSpy = jest.fn(() => observableThrow("nope"));
    mockCompat({ requestMediaKeySystemAccess: requestMediaKeySystemAccessSpy });
    await checkIncompatibleKeySystemsErrorMessage([{ type: "playready",
                                                     getLicense: neverCalledFn }]);
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledTimes(3);
    expect(requestMediaKeySystemAccessSpy)
      .toHaveBeenNthCalledWith(1, "com.microsoft.playready", defaultKSConfig);
    expect(requestMediaKeySystemAccessSpy)
      .toHaveBeenNthCalledWith(2, "com.chromecast.playready", defaultKSConfig);
    expect(requestMediaKeySystemAccessSpy)
      .toHaveBeenNthCalledWith(3, "com.youtube.playready", defaultKSConfig);
  });

  it("should translate a `fairplay` keySystem", async () => {
    const requestMediaKeySystemAccessSpy = jest.fn(() => observableThrow("nope"));
    mockCompat({ requestMediaKeySystemAccess: requestMediaKeySystemAccessSpy });
    await checkIncompatibleKeySystemsErrorMessage([{ type: "fairplay",
                                                     getLicense: neverCalledFn }]);
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledTimes(1);
    expect(requestMediaKeySystemAccessSpy)
      .toHaveBeenCalledWith("com.apple.fps.1_0", defaultKSConfig);
  });

  it("should translate a multiple keySystems at the same time", async () => {
    const requestMediaKeySystemAccessSpy = jest.fn(() => observableThrow("nope"));
    mockCompat({ requestMediaKeySystemAccess: requestMediaKeySystemAccessSpy });
    await checkIncompatibleKeySystemsErrorMessage([{ type: "playready",
                                                     getLicense: neverCalledFn },
                                                   { type: "clearkey",
                                                     getLicense: neverCalledFn }]);
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledTimes(5);
    expect(requestMediaKeySystemAccessSpy)
      .toHaveBeenNthCalledWith(1, "com.microsoft.playready", defaultKSConfig);
    expect(requestMediaKeySystemAccessSpy)
      .toHaveBeenNthCalledWith(2, "com.chromecast.playready", defaultKSConfig);
    expect(requestMediaKeySystemAccessSpy)
      .toHaveBeenNthCalledWith(3, "com.youtube.playready", defaultKSConfig);
    expect(requestMediaKeySystemAccessSpy)
      .toHaveBeenNthCalledWith(4, "webkit-org.w3.clearkey", defaultKSConfig);
    expect(requestMediaKeySystemAccessSpy)
      .toHaveBeenNthCalledWith(5, "org.w3.clearkey", defaultKSConfig);
  });

  /* tslint:disable max-line-length */
  it("should translate a multiple keySystems at the same time with different configs", async () => {
  /* tslint:enable max-line-length */
    const requestMediaKeySystemAccessSpy = jest.fn(() => observableThrow("nope"));
    mockCompat({ requestMediaKeySystemAccess: requestMediaKeySystemAccessSpy });
    await checkIncompatibleKeySystemsErrorMessage([{ type: "playready",
                                                     persistentLicense: true,
                                                     getLicense: neverCalledFn },
                                                   { type: "clearkey",
                                                     distinctiveIdentifierRequired: true,
                                                     getLicense: neverCalledFn }]);
    const expectedPersistentConfig = defaultKSConfig.map(conf => {
      /* tslint:disable ban */
      return Object.assign({}, conf, { persistentState: "required",
                                       sessionTypes: ["temporary",
                                                      "persistent-license"] });
      /* tslint:enable ban */
    });
    const expectedIdentifierConfig = defaultKSConfig.map(conf => {
      /* tslint:disable ban */
      return Object.assign({}, conf, { distinctiveIdentifier: "required" });
      /* tslint:enable ban */
    });
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledTimes(5);
    expect(requestMediaKeySystemAccessSpy)
      .toHaveBeenNthCalledWith(1, "com.microsoft.playready", expectedPersistentConfig);
    expect(requestMediaKeySystemAccessSpy)
      .toHaveBeenNthCalledWith(2, "com.chromecast.playready", expectedPersistentConfig);
    expect(requestMediaKeySystemAccessSpy)
      .toHaveBeenNthCalledWith(3, "com.youtube.playready", expectedPersistentConfig);
    expect(requestMediaKeySystemAccessSpy)
      .toHaveBeenNthCalledWith(4, "webkit-org.w3.clearkey", expectedIdentifierConfig);
    expect(requestMediaKeySystemAccessSpy)
      .toHaveBeenNthCalledWith(5, "org.w3.clearkey", expectedIdentifierConfig);
  });

  /* tslint:disable max-line-length */
  it("should set widevine robustnesses for a `com.widevine.alpha` keySystem", async () => {
  /* tslint:enable max-line-length */
    const requestMediaKeySystemAccessSpy = jest.fn(() => observableThrow("nope"));
    mockCompat({ requestMediaKeySystemAccess: requestMediaKeySystemAccessSpy });
    await checkIncompatibleKeySystemsErrorMessage([{ type: "com.widevine.alpha",
                                                     getLicense: neverCalledFn }]);
    expect(requestMediaKeySystemAccessSpy).toHaveBeenCalledTimes(1);
    expect(requestMediaKeySystemAccessSpy)
      .toHaveBeenCalledWith("com.widevine.alpha", defaultWidevineConfig);
  });

  xit("should not continue to check if the observable is unsubscribed from", () => {
    return new Promise((res, rej) => {
      const killSubject$ = new Subject();
      let rmksHasBeenCalled = false;
      const requestMediaKeySystemAccessSpy = jest.fn(() => {
        if (rmksHasBeenCalled) {
          rej("requestMediaKeySystemAccess has already been called.");
        }
        rmksHasBeenCalled = true;
        killSubject$.next();
        killSubject$.complete();
        return observableThrow("nope");
      });
      mockCompat({ requestMediaKeySystemAccess: requestMediaKeySystemAccessSpy });
      const mediaElement = document.createElement("video");
      const EMEManager = require("../../eme_manager").default;

      const config = [ { type: "foo", getLicense: neverCalledFn },
                       { type: "bar", getLicense: neverCalledFn },
                       { type: "baz", getLicense: neverCalledFn } ];
      EMEManager(mediaElement, config, EMPTY)
        .pipe(takeUntil(killSubject$))
        .subscribe(
          () => { rej("We should not have received an event"); },
          () => { rej("We should not have received an error."); },
          () =>  {
            expect(rmksHasBeenCalled).toBe(true);
            setTimeout(() => { res(); }, 10);
          }
        );
      });
  });
});

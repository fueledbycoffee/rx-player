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
  // of as observableOf,
  Subject,
  // throwError as observableThrow,
} from "rxjs";
import { takeUntil } from "rxjs/operators";
import { IContentProtection } from "../../types";
import {
  expectEncryptedEventReceived,
  expectInitDataIgnored,
  expectLicenseRequestMessage,
  MediaKeySessionImpl,
  MediaKeysImpl,
  // MediaKeySystemAccessImpl,
  mockCompat,
  // testEMEManagerImmediateError,
} from "./utils";

/**
 * Create fake encrypted event which should (hopefully) be processed by the EME
 * logic.
 * @param {string} initDataType
 * @param {Uint8Array} initData
 * @returns {Object}
 */
function generateEncryptedEvent(
  initDataType : string,
  initData : Uint8Array
) : Event & { initDataType : string; initData : ArrayBuffer } {
  /* tslint:disable ban */
  return Object.assign(new Event("encrypted"),
                       { initDataType, initData: initData.buffer });
  /* tslint:enable ban */
}

/* tslint:disable no-unsafe-any */
describe("core - eme - global tests - init data", () => {
  /** Default video element used in our tests. */
  const videoElt = document.createElement("video");

  const getLicenseSpy = jest.fn(() => {
    /* tslint:disable ban */
    return new Promise(() => { /* noop */ });
    /* tslint:enable ban */
  });

  /** Default keySystems configuration used in our tests. */
  const ksConfig = [{ type: "com.widevine.alpha", getLicense: getLicenseSpy }];

  beforeEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  /* tslint:disable max-line-length */
  it("should create a session and generate a request when init data is sent through the arguments", (done) => {
  /* tslint:enable max-line-length */

    // == mocks ==
    const { generateKeyRequestSpy } = mockCompat();
    const mediaKeySession = new MediaKeySessionImpl();
    const createSessionSpy = jest.spyOn(MediaKeysImpl.prototype, "createSession")
      .mockReturnValue(mediaKeySession);

    // == vars ==
    let eventsReceived = 0;
    const initDataSubject = new Subject<IContentProtection>();
    const initData = new Uint8Array([54, 55, 75]);
    const kill$ = new Subject();

    // == test ==
    const EMEManager = require("../../eme_manager").default;
    EMEManager(videoElt, ksConfig, initDataSubject)
      .pipe(takeUntil(kill$))
      .subscribe((evt : any) => {
        switch (++eventsReceived) {
          case 1:
            expect(evt.type).toEqual("created-media-keys");
            break;
          case 2:
            expect(evt.type).toEqual("attached-media-keys");
            break;
          case 3:
            expectLicenseRequestMessage(evt, initData, "cenc");
            setTimeout(() => {
              kill$.next();
              expect(createSessionSpy).toHaveBeenCalledTimes(1);
              expect(createSessionSpy).toHaveBeenCalledWith("temporary");
              expect(generateKeyRequestSpy).toHaveBeenCalledTimes(1);
              expect(generateKeyRequestSpy)
                .toHaveBeenCalledWith(mediaKeySession, initData, "cenc");
              done();
            }, 10);
            break;
          default:
            throw new Error("Unexpected event");
        }
      });
    initDataSubject.next({ type: "cenc", data: initData });
  });

  /* tslint:disable max-line-length */
  it("should ignore init data already sent through the argument", (done) => {
  /* tslint:enable max-line-length */

    // == mocks ==
    const { generateKeyRequestSpy } = mockCompat();
    const mediaKeySession = new MediaKeySessionImpl();
    const createSessionSpy = jest.spyOn(MediaKeysImpl.prototype, "createSession")
      .mockReturnValue(mediaKeySession);

    // == vars ==
    const initDataSubject = new Subject<IContentProtection>();
    let eventsReceived = 0;
    const initData = new Uint8Array([54, 55, 75]);
    const kill$ = new Subject();

    // == test ==
    const EMEManager = require("../../eme_manager").default;
    EMEManager(videoElt, ksConfig, initDataSubject)
      .pipe(takeUntil(kill$))
      .subscribe((evt : any) => {
        switch (++eventsReceived) {
          case 1:
            expect(evt.type).toEqual("created-media-keys");
            break;
          case 2:
            expect(evt.type).toEqual("attached-media-keys");
            break;
          case 3:
            expectLicenseRequestMessage(evt, initData, "cenc");
            break;
          case 4:
          case 5:
          case 6:
            expectInitDataIgnored(evt, initData, "cenc");
            if (eventsReceived === 6) {
              setTimeout(() => {
                kill$.next();
                expect(createSessionSpy).toHaveBeenCalledTimes(1);
                expect(createSessionSpy).toHaveBeenCalledWith("temporary");
                expect(generateKeyRequestSpy).toHaveBeenCalledTimes(1);
                expect(generateKeyRequestSpy)
                  .toHaveBeenCalledWith(mediaKeySession, initData, "cenc");
                done();
              }, 10);
            }
            break;
          default:
            throw new Error("Unexpected event");
        }
      });
    initDataSubject.next({ type: "cenc", data: initData });
    initDataSubject.next({ type: "cenc", data: initData });
    initDataSubject.next({ type: "cenc", data: initData });
    initDataSubject.next({ type: "cenc", data: initData });
  });

  /* tslint:disable max-line-length */
  it("should create multiple sessions for multiple sent init data when unknown", (done) => {
  /* tslint:enable max-line-length */

    // == mocks ==
    const { generateKeyRequestSpy } = mockCompat();
    const mediaKeySession1 = new MediaKeySessionImpl();
    const mediaKeySession2 = new MediaKeySessionImpl();
    let createSessionCallIdx = 0;
    const createSessionSpy = jest.spyOn(MediaKeysImpl.prototype, "createSession")
      .mockImplementation(() => {
        return createSessionCallIdx++ === 0 ? mediaKeySession1 :
                                              mediaKeySession2;
      });

    // == vars ==
    const initDataSubject = new Subject<IContentProtection>();
    let eventsReceived = 0;
    const initData1 = new Uint8Array([54, 55, 75]);
    const initData2 = new Uint8Array([87, 32]);
    const kill$ = new Subject();

    // == test ==
    const EMEManager = require("../../eme_manager").default;
    EMEManager(videoElt, ksConfig, initDataSubject)
      .pipe(takeUntil(kill$))
      .subscribe((evt : any) => {
        switch (++eventsReceived) {
          case 1:
            expect(evt.type).toEqual("created-media-keys");
            break;
          case 2:
            expect(evt.type).toEqual("attached-media-keys");
            break;
          case 3:
            expectLicenseRequestMessage(evt, initData1, "cenc");
            break;
          case 4:
            expectInitDataIgnored(evt, initData1, "cenc");
            break;
          case 5:
            expectLicenseRequestMessage(evt, initData2, "cenc");
            break;
          case 6:
            expectInitDataIgnored(evt, initData1, "cenc");
            break;
          case 7:
            expectInitDataIgnored(evt, initData2, "cenc");
            setTimeout(() => {
              kill$.next();
              expect(createSessionSpy).toHaveBeenCalledTimes(2);
              expect(createSessionSpy).toHaveBeenNthCalledWith(1, "temporary");
              expect(createSessionSpy).toHaveBeenNthCalledWith(2, "temporary");
              expect(generateKeyRequestSpy).toHaveBeenCalledTimes(2);
              expect(generateKeyRequestSpy)
                .toHaveBeenNthCalledWith(1, mediaKeySession1, initData1, "cenc");
              expect(generateKeyRequestSpy)
                .toHaveBeenNthCalledWith(2, mediaKeySession2, initData2, "cenc");
              done();
            }, 10);
            break;
          default:
            throw new Error("Unexpected event");
        }
      });
    initDataSubject.next({ type: "cenc", data: initData1 });
    initDataSubject.next({ type: "cenc", data: initData1 });
    initDataSubject.next({ type: "cenc", data: initData2 });
    initDataSubject.next({ type: "cenc", data: initData1 });
    initDataSubject.next({ type: "cenc", data: initData2 });
  });

  /* tslint:disable max-line-length */
  it("should create multiple sessions for multiple sent init data types", (done) => {
  /* tslint:enable max-line-length */

    // == mocks ==
    const { generateKeyRequestSpy } = mockCompat();
    const mediaKeySessions = [ new MediaKeySessionImpl(),
                               new MediaKeySessionImpl(),
                               new MediaKeySessionImpl(),
                               new MediaKeySessionImpl() ];
    let createSessionCallIdx = 0;
    const createSessionSpy = jest.spyOn(MediaKeysImpl.prototype, "createSession")
      .mockImplementation(() => {
        return mediaKeySessions[createSessionCallIdx++];
      });

    // == vars ==
    const initDataSubject = new Subject<IContentProtection>();
    let eventsReceived = 0;
    const initData1 = new Uint8Array([54, 55, 75]);
    const initData2 = new Uint8Array([87, 32]);
    const kill$ = new Subject();

    // == test ==
    const EMEManager = require("../../eme_manager").default;
    EMEManager(videoElt, ksConfig, initDataSubject)
      .pipe(takeUntil(kill$))
      .subscribe((evt : any) => {
        switch (++eventsReceived) {
          case 1:
            expect(evt.type).toEqual("created-media-keys");
            break;
          case 2:
            expect(evt.type).toEqual("attached-media-keys");
            break;
          case 3:
            expectLicenseRequestMessage(evt, initData1, "cenc");
            break;
          case 4:
            expectLicenseRequestMessage(evt, initData1, "cenc2");
            break;
          case 5:
            expectLicenseRequestMessage(evt, initData2, "cenc");
            break;
          case 6:
            expectLicenseRequestMessage(evt, initData2, "cenc2");
            setTimeout(() => {
              kill$.next();
              expect(createSessionSpy).toHaveBeenCalledTimes(4);
              expect(createSessionSpy).toHaveBeenNthCalledWith(1, "temporary");
              expect(createSessionSpy).toHaveBeenNthCalledWith(2, "temporary");
              expect(createSessionSpy).toHaveBeenNthCalledWith(3, "temporary");
              expect(createSessionSpy).toHaveBeenNthCalledWith(4, "temporary");
              expect(generateKeyRequestSpy).toHaveBeenCalledTimes(4);
              expect(generateKeyRequestSpy)
                .toHaveBeenNthCalledWith(1, mediaKeySessions[0], initData1, "cenc");
              expect(generateKeyRequestSpy)
                .toHaveBeenNthCalledWith(2, mediaKeySessions[1], initData1, "cenc2");
              expect(generateKeyRequestSpy)
                .toHaveBeenNthCalledWith(3, mediaKeySessions[2], initData2, "cenc");
              expect(generateKeyRequestSpy)
                .toHaveBeenNthCalledWith(4, mediaKeySessions[3], initData2, "cenc2");
              done();
            }, 10);
            break;
          default:
            throw new Error("Unexpected event");
        }
      });
    initDataSubject.next({ type: "cenc", data: initData1 });
    initDataSubject.next({ type: "cenc2", data: initData1 });
    initDataSubject.next({ type: "cenc", data: initData2 });
    initDataSubject.next({ type: "cenc2", data: initData2 });
  });

  /* tslint:disable max-line-length */
  it("should create a session and generate a request when init data is received from the browser", (done) => {
  /* tslint:enable max-line-length */

    // == mocks ==
    const { generateKeyRequestSpy, eventTriggers, getInitDataSpy } = mockCompat();
    const { triggerEncrypted } = eventTriggers;
    const mediaKeySession = new MediaKeySessionImpl();
    const createSessionSpy = jest.spyOn(MediaKeysImpl.prototype, "createSession")
      .mockReturnValue(mediaKeySession);

    // == vars ==
    let eventsReceived = 0;
    const initData = new Uint8Array([54, 55, 75]);
    const initDataEvent = generateEncryptedEvent("cenc", initData);
    const kill$ = new Subject();

    // == test ==
    const EMEManager = require("../../eme_manager").default;
    EMEManager(videoElt, ksConfig, EMPTY)
      .pipe(takeUntil(kill$))
      .subscribe((evt : any) => {
        switch (++eventsReceived) {
          case 1:
            expectEncryptedEventReceived(evt, initData, "cenc");
            expect(getInitDataSpy).toHaveBeenCalledTimes(1);
            expect(getInitDataSpy).toHaveBeenCalledWith(initDataEvent);
            break;
          case 2:
            expect(evt.type).toEqual("created-media-keys");
            break;
          case 3:
            expect(evt.type).toEqual("attached-media-keys");
            break;
          case 4:
            expectLicenseRequestMessage(evt, initData, "cenc");
            setTimeout(() => {
              kill$.next();
              expect(createSessionSpy).toHaveBeenCalledTimes(1);
              expect(createSessionSpy).toHaveBeenCalledWith("temporary");
              expect(generateKeyRequestSpy).toHaveBeenCalledTimes(1);
              expect(generateKeyRequestSpy)
                .toHaveBeenCalledWith(mediaKeySession, initData, "cenc");
              done();
            }, 10);
            break;
          default:
            throw new Error("Unexpected event");
        }
      });
    triggerEncrypted.next(initDataEvent);
  });

  /* tslint:disable max-line-length */
  it("should ignore init data already received through the browser", (done) => {
  /* tslint:enable max-line-length */

    // == mocks ==
    const { generateKeyRequestSpy, eventTriggers, getInitDataSpy } = mockCompat();
    const { triggerEncrypted } = eventTriggers;
    const mediaKeySession = new MediaKeySessionImpl();
    const createSessionSpy = jest.spyOn(MediaKeysImpl.prototype, "createSession")
      .mockReturnValue(mediaKeySession);

    // == vars ==
    let eventsReceived = 0;
    const initData = new Uint8Array([54, 55, 75]);
    const initDataEvent = generateEncryptedEvent("cenc", initData);
    const kill$ = new Subject();

    // == test ==
    const EMEManager = require("../../eme_manager").default;
    EMEManager(videoElt, ksConfig, EMPTY)
      .pipe(takeUntil(kill$))
      .subscribe((evt : any) => {
        switch (++eventsReceived) {
          case 1:
          case 2:
          case 3:
          case 4:
            expectEncryptedEventReceived(evt, initData, "cenc");
            expect(getInitDataSpy).toHaveBeenCalledTimes(eventsReceived);
            expect(getInitDataSpy).toHaveBeenNthCalledWith(eventsReceived, initDataEvent);
            break;
          case 5:
            expect(evt.type).toEqual("created-media-keys");
            break;
          case 6:
            expect(evt.type).toEqual("attached-media-keys");
            break;
          case 7:
            expectLicenseRequestMessage(evt, initData, "cenc");
            break;
          case 8:
          case 9:
          case 10:
            expectInitDataIgnored(evt, initData, "cenc");
            if (eventsReceived === 10) {
              setTimeout(() => {
                kill$.next();
                expect(createSessionSpy).toHaveBeenCalledTimes(1);
                expect(createSessionSpy).toHaveBeenCalledWith("temporary");
                expect(generateKeyRequestSpy).toHaveBeenCalledTimes(1);
                expect(generateKeyRequestSpy)
                  .toHaveBeenCalledWith(mediaKeySession, initData, "cenc");
                done();
              }, 10);
            }
            break;
          default:
            throw new Error("Unexpected event");
        }
      });
    triggerEncrypted.next(initDataEvent);
    triggerEncrypted.next(initDataEvent);
    triggerEncrypted.next(initDataEvent);
    triggerEncrypted.next(initDataEvent);
  });

  /* tslint:disable max-line-length */
  it("should create multiple sessions for multiple received init data when unknown", (done) => {
  /* tslint:enable max-line-length */

    // == mocks ==
    const { generateKeyRequestSpy, eventTriggers, getInitDataSpy } = mockCompat();
    const { triggerEncrypted } = eventTriggers;
    const mediaKeySession1 = new MediaKeySessionImpl();
    const mediaKeySession2 = new MediaKeySessionImpl();
    let createSessionCallIdx = 0;
    const createSessionSpy = jest.spyOn(MediaKeysImpl.prototype, "createSession")
      .mockImplementation(() => {
        return createSessionCallIdx++ === 0 ? mediaKeySession1 :
                                              mediaKeySession2;
      });

    // == vars ==
    let eventsReceived = 0;
    const initData1 = new Uint8Array([54, 55, 75]);
    const initData2 = new Uint8Array([87, 32]);
    const initDataEvent1 = generateEncryptedEvent("cenc", initData1);
    const initDataEvent2 = generateEncryptedEvent("cenc", initData2);
    const kill$ = new Subject();

    function checkEncryptedEventReceived(
      evt : any,
      initDataEvent : unknown,
      initData : Uint8Array,
      nb : number
    ) {
      expect(evt.type).toEqual("encrypted-event-received");
      expect(evt.value.type).toEqual("cenc");
      expect(evt.value.data).toEqual(initData);
      expect(getInitDataSpy).toHaveBeenCalledTimes(nb);
      expect(getInitDataSpy)
        .toHaveBeenNthCalledWith(nb, initDataEvent);
    }

    // == test ==
    const EMEManager = require("../../eme_manager").default;
    EMEManager(videoElt, ksConfig, EMPTY)
      .pipe(takeUntil(kill$))
      .subscribe((evt : any) => {
        switch (++eventsReceived) {
          case 1:
          case 2:
            checkEncryptedEventReceived(evt, initDataEvent1, initData1, eventsReceived);
            break;
          case 3: checkEncryptedEventReceived(evt, initDataEvent2, initData2, 3); break;
          case 4: checkEncryptedEventReceived(evt, initDataEvent1, initData1, 4); break;
          case 5: checkEncryptedEventReceived(evt, initDataEvent2, initData2, 5); break;
          case 6: expect(evt.type).toEqual("created-media-keys"); break;
          case 7: expect(evt.type).toEqual("attached-media-keys"); break;
          case 8: expectLicenseRequestMessage(evt, initData1, "cenc"); break;
          case 9: expectInitDataIgnored(evt, initData1, "cenc"); break;
          case 10: expectLicenseRequestMessage(evt, initData2, "cenc"); break;
          case 11: expectInitDataIgnored(evt, initData1, "cenc"); break;
          case 12:
            expectInitDataIgnored(evt, initData2, "cenc");
            setTimeout(() => {
              kill$.next();
              expect(createSessionSpy).toHaveBeenCalledTimes(2);
              expect(createSessionSpy).toHaveBeenNthCalledWith(1, "temporary");
              expect(createSessionSpy).toHaveBeenNthCalledWith(2, "temporary");
              expect(generateKeyRequestSpy).toHaveBeenCalledTimes(2);
              expect(generateKeyRequestSpy)
                .toHaveBeenNthCalledWith(1, mediaKeySession1, initData1, "cenc");
              expect(generateKeyRequestSpy)
                .toHaveBeenNthCalledWith(2, mediaKeySession2, initData2, "cenc");
              done();
            }, 10);
            break;
          default:
            throw new Error(`Unexpected event: ${evt.type}`);
        }
      });
    triggerEncrypted.next(initDataEvent1);
    triggerEncrypted.next(initDataEvent1);
    triggerEncrypted.next(initDataEvent2);
    triggerEncrypted.next(initDataEvent1);
    triggerEncrypted.next(initDataEvent2);
  });

  /* tslint:disable max-line-length */
  it("should create multiple sessions for multiple received init data types", (done) => {
  /* tslint:enable max-line-length */

    // == mocks ==
    const { generateKeyRequestSpy, eventTriggers, getInitDataSpy } = mockCompat();
    const { triggerEncrypted } = eventTriggers;
    const mediaKeySessions = [ new MediaKeySessionImpl(),
                               new MediaKeySessionImpl(),
                               new MediaKeySessionImpl(),
                               new MediaKeySessionImpl() ];
    let createSessionCallIdx = 0;
    const createSessionSpy = jest.spyOn(MediaKeysImpl.prototype, "createSession")
      .mockImplementation(() => {
        return mediaKeySessions[createSessionCallIdx++];
      });

    // == vars ==
    let eventsReceived = 0;
    const initData1 = new Uint8Array([54, 55, 75]);
    const initData2 = new Uint8Array([87, 32]);
    const initDataEvent1 = generateEncryptedEvent("cenc", initData1);
    const initDataEvent2 = generateEncryptedEvent("cenc2", initData1);
    const initDataEvent3 = generateEncryptedEvent("cenc", initData2);
    const initDataEvent4 = generateEncryptedEvent("cenc2", initData2);
    const kill$ = new Subject();

    function checkEncryptedEventReceived(
      evt : any,
      initDataEvent : { initDataType : string },
      initData : Uint8Array,
      nb : number
    ) {
      expect(evt.type).toEqual("encrypted-event-received");
      expect(evt.value.type).toEqual(initDataEvent.initDataType);
      expect(evt.value.data).toEqual(initData);
      expect(getInitDataSpy).toHaveBeenCalledTimes(nb);
      expect(getInitDataSpy)
        .toHaveBeenNthCalledWith(nb, initDataEvent);
    }

    // == test ==
    const EMEManager = require("../../eme_manager").default;
    EMEManager(videoElt, ksConfig, EMPTY)
      .pipe(takeUntil(kill$))
      .subscribe((evt : any) => {
        switch (++eventsReceived) {
          case 1: checkEncryptedEventReceived(evt, initDataEvent1, initData1, 1); break;
          case 2: checkEncryptedEventReceived(evt, initDataEvent2, initData1, 2); break;
          case 3: checkEncryptedEventReceived(evt, initDataEvent3, initData2, 3); break;
          case 4: checkEncryptedEventReceived(evt, initDataEvent4, initData2, 4); break;
          case 5: expect(evt.type).toEqual("created-media-keys"); break;
          case 6: expect(evt.type).toEqual("attached-media-keys"); break;
          case 7: expectLicenseRequestMessage(evt, initData1, "cenc"); break;
          case 8: expectLicenseRequestMessage(evt, initData1, "cenc2"); break;
          case 9: expectLicenseRequestMessage(evt, initData2, "cenc"); break;
          case 10:
            expectLicenseRequestMessage(evt, initData2, "cenc2");
            setTimeout(() => {
              kill$.next();
              expect(createSessionSpy).toHaveBeenCalledTimes(4);
              expect(createSessionSpy).toHaveBeenNthCalledWith(1, "temporary");
              expect(createSessionSpy).toHaveBeenNthCalledWith(2, "temporary");
              expect(createSessionSpy).toHaveBeenNthCalledWith(3, "temporary");
              expect(createSessionSpy).toHaveBeenNthCalledWith(4, "temporary");
              expect(generateKeyRequestSpy).toHaveBeenCalledTimes(4);
              expect(generateKeyRequestSpy)
                .toHaveBeenNthCalledWith(1, mediaKeySessions[0], initData1, "cenc");
              expect(generateKeyRequestSpy)
                .toHaveBeenNthCalledWith(2, mediaKeySessions[1], initData1, "cenc2");
              expect(generateKeyRequestSpy)
                .toHaveBeenNthCalledWith(3, mediaKeySessions[2], initData2, "cenc");
              expect(generateKeyRequestSpy)
                .toHaveBeenNthCalledWith(4, mediaKeySessions[3], initData2, "cenc2");
              done();
            }, 10);
            break;
          default:
            throw new Error("Unexpected event");
        }
      });
    triggerEncrypted.next(initDataEvent1);
    triggerEncrypted.next(initDataEvent2);
    triggerEncrypted.next(initDataEvent3);
    triggerEncrypted.next(initDataEvent4);
  });

  it("should consider sent event through arguments and received events through the browser the same way", (done) => {
    // == mocks ==
    const { generateKeyRequestSpy, eventTriggers, getInitDataSpy } = mockCompat();
    const { triggerEncrypted } = eventTriggers;
    const mediaKeySessions = [ new MediaKeySessionImpl(),
                               new MediaKeySessionImpl(),
                               new MediaKeySessionImpl(),
                               new MediaKeySessionImpl() ];
    let createSessionCallIdx = 0;
    const createSessionSpy = jest.spyOn(MediaKeysImpl.prototype, "createSession")
      .mockImplementation(() => {
        return mediaKeySessions[createSessionCallIdx++];
      });

    // == vars ==
    const initDataSubject = new Subject<IContentProtection>();
    let eventsReceived = 0;
    const initData1 = new Uint8Array([54, 55, 75]);
    const initData2 = new Uint8Array([87, 32]);
    const initDataEvent1 = generateEncryptedEvent("cenc", initData1);
    const initDataEvent2 = generateEncryptedEvent("cenc2", initData1);
    const initDataEvent3 = generateEncryptedEvent("cenc", initData2);
    const initDataEvent4 = generateEncryptedEvent("cenc2", initData2);
    const kill$ = new Subject();

    function checkEncryptedEventReceived(
      evt : any,
      initDataEvent : { initDataType : string },
      initData : Uint8Array,
      nb : number
    ) {
      expect(evt.type).toEqual("encrypted-event-received");
      expect(evt.value.type).toEqual(initDataEvent.initDataType);
      expect(evt.value.data).toEqual(initData);
      expect(getInitDataSpy).toHaveBeenCalledTimes(nb);
      expect(getInitDataSpy)
        .toHaveBeenNthCalledWith(nb, initDataEvent);
    }

    // == test ==
    const EMEManager = require("../../eme_manager").default;
    EMEManager(videoElt, ksConfig, initDataSubject)
      .pipe(takeUntil(kill$))
      .subscribe((evt : any) => {
        switch (++eventsReceived) {
          case 1: checkEncryptedEventReceived(evt, initDataEvent1, initData1, 1); break;
          case 2: expect(evt.type).toEqual("created-media-keys"); break;
          case 3:
            expect(evt.type).toEqual("attached-media-keys");
            expect(createSessionSpy).toHaveBeenCalledTimes(0);
            expect(generateKeyRequestSpy).toHaveBeenCalledTimes(0);
            break;
          case 4:
            expectLicenseRequestMessage(evt, initData1, "cenc");
            expect(createSessionSpy).toHaveBeenCalledTimes(1);
            expect(createSessionSpy).toHaveBeenNthCalledWith(1, "temporary");
            expect(generateKeyRequestSpy).toHaveBeenCalledTimes(1);
            expect(generateKeyRequestSpy)
              .toHaveBeenNthCalledWith(1, mediaKeySessions[0], initData1, "cenc");
            break;
          case 5:
            expectInitDataIgnored(evt, initData1, "cenc");
            expect(getInitDataSpy).toHaveBeenCalledTimes(1);
            expect(createSessionSpy).toHaveBeenCalledTimes(1);
            expect(generateKeyRequestSpy).toHaveBeenCalledTimes(1);
            break;
          case 6:
            expectLicenseRequestMessage(evt, initData1, "cenc2");
            expect(createSessionSpy).toHaveBeenCalledTimes(2);
            expect(createSessionSpy).toHaveBeenNthCalledWith(2, "temporary");
            expect(generateKeyRequestSpy).toHaveBeenCalledTimes(2);
            expect(generateKeyRequestSpy)
              .toHaveBeenNthCalledWith(2, mediaKeySessions[1], initData1, "cenc2");
            break;
          case 7:
            checkEncryptedEventReceived(evt, initDataEvent2, initData1, 2);
            expect(getInitDataSpy).toHaveBeenCalledTimes(2);
            expect(createSessionSpy).toHaveBeenCalledTimes(2);
            expect(generateKeyRequestSpy).toHaveBeenCalledTimes(2);
            break;
          case 8:
            expectInitDataIgnored(evt, initData1, "cenc2");
            expect(getInitDataSpy).toHaveBeenCalledTimes(2);
            expect(createSessionSpy).toHaveBeenCalledTimes(2);
            expect(generateKeyRequestSpy).toHaveBeenCalledTimes(2);
            break;
          case 9:
            expectInitDataIgnored(evt, initData1, "cenc");
            expect(getInitDataSpy).toHaveBeenCalledTimes(2);
            expect(createSessionSpy).toHaveBeenCalledTimes(2);
            expect(generateKeyRequestSpy).toHaveBeenCalledTimes(2);
            break;
          case 10:
            checkEncryptedEventReceived(evt, initDataEvent3, initData2, 3);
            expect(getInitDataSpy).toHaveBeenCalledTimes(3);
            expect(createSessionSpy).toHaveBeenCalledTimes(2);
            expect(generateKeyRequestSpy).toHaveBeenCalledTimes(2);
            break;
          case 11:
            expectLicenseRequestMessage(evt, initData2, "cenc");
            expect(createSessionSpy).toHaveBeenCalledTimes(3);
            expect(createSessionSpy).toHaveBeenNthCalledWith(3, "temporary");
            expect(generateKeyRequestSpy).toHaveBeenCalledTimes(3);
            expect(generateKeyRequestSpy)
              .toHaveBeenNthCalledWith(3, mediaKeySessions[2], initData2, "cenc");
            break;
          case 12:
            expectInitDataIgnored(evt, initData2, "cenc");
            expect(getInitDataSpy).toHaveBeenCalledTimes(3);
            expect(createSessionSpy).toHaveBeenCalledTimes(3);
            expect(generateKeyRequestSpy).toHaveBeenCalledTimes(3);
            break;
          case 13:
            checkEncryptedEventReceived(evt, initDataEvent4, initData2, 4);
            expect(getInitDataSpy).toHaveBeenCalledTimes(4);
            expect(createSessionSpy).toHaveBeenCalledTimes(3);
            expect(generateKeyRequestSpy).toHaveBeenCalledTimes(3);
            break;
          case 14:
            expectLicenseRequestMessage(evt, initData2, "cenc2");
            setTimeout(() => {
              expect(createSessionSpy).toHaveBeenCalledTimes(4);
              expect(createSessionSpy).toHaveBeenNthCalledWith(4, "temporary");
              expect(generateKeyRequestSpy).toHaveBeenCalledTimes(4);
              expect(generateKeyRequestSpy)
                .toHaveBeenNthCalledWith(4, mediaKeySessions[3], initData2, "cenc2");
              kill$.next();
              done();
            }, 5);
            break;
          default:
            throw new Error("Unexpected event");
        }
      });
    triggerEncrypted.next(initDataEvent1);
    initDataSubject.next({ type: "cenc", data: initData1 });
    setTimeout(() => {
      initDataSubject.next({ type: "cenc2", data: initData1 });
      triggerEncrypted.next(initDataEvent2);
      initDataSubject.next({ type: "cenc", data: initData1 });
      triggerEncrypted.next(initDataEvent3);
      initDataSubject.next({ type: "cenc", data: initData2 });
      triggerEncrypted.next(initDataEvent4);
    }, 5);
  });
});

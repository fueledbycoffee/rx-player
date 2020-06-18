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
  merge as observableMerge,
  Subject,
} from "rxjs";
import { takeUntil } from "rxjs/operators";
import { TypedArray } from "../../../core/eme";
import {
  bytesToStr,
  strToBytes,
} from "../../../utils/byte_parsing";
import EventEmitter from "../../../utils/event_emitter";
import PPromise from "../../../utils/promise";
import * as events from "../../event_listeners";
import {
  ICustomMediaKeys,
  ICustomMediaKeySession,
  ICustomMediaKeyStatusMap,
  IMediaKeySessionEvents,
} from "./types";

export interface IOldWebkitHTMLMediaElement extends HTMLVideoElement {
  webkitGenerateKeyRequest : (keyType: string, initData : ArrayBuffer) => void;
  webkitAddKey : (
    keyType: string,
    key : ArrayBuffer|TypedArray|DataView,
    kid : ArrayBuffer|TypedArray|DataView|null,
    sessionId : string
  ) => void;
}

/**
 * Returns true if the given media element has old webkit methods
 * corresponding to the IOldWebkitHTMLMediaElement interface.
 * @param {HTMLMediaElement} element
 * @returns {Boolean}
 */
export function isOldWebkitMediaElement(
  element : HTMLMediaElement|IOldWebkitHTMLMediaElement
) : element is IOldWebkitHTMLMediaElement {
  return typeof (element as IOldWebkitHTMLMediaElement)
    .webkitGenerateKeyRequest === "function";
}

class OldWebkitMediaKeySession extends EventEmitter<IMediaKeySessionEvents>
                               implements ICustomMediaKeySession {
  public readonly update: (license: Uint8Array) =>
    Promise<void>;
  public readonly closed: Promise<void>;
  public expiration: number;
  public keyStatuses: ICustomMediaKeyStatusMap;
  public sessionId: string;

  private readonly _vid: IOldWebkitHTMLMediaElement;
  private readonly _key: string;
  private readonly _closeSession$: Subject<void>;

  constructor(mediaElement: IOldWebkitHTMLMediaElement,
              keySystem: string) {
    super();
    this._closeSession$ = new Subject();
    this._vid = mediaElement;
    this._key = keySystem;

    this.sessionId = "";
    this.closed = new PPromise((resolve) => {
      this._closeSession$.subscribe(resolve);
    });
    this.keyStatuses = new Map();
    this.expiration = NaN;

    observableMerge(events.onKeyMessage$(mediaElement),
                    events.onKeyAdded$(mediaElement),
                    events.onKeyError$(mediaElement))
      .pipe(takeUntil(this._closeSession$))
      .subscribe((evt: Event) => this.trigger(evt.type, evt));

    this.update = (license: Uint8Array) => {
      return new PPromise((resolve, reject) => {
        try {
          if (this._key.indexOf("clearkey") >= 0) {
            const licenseTypedArray =
              license instanceof ArrayBuffer ? new Uint8Array(license) :
                                               license;
            /* tslint:disable no-unsafe-any */
            const json = JSON.parse(bytesToStr(licenseTypedArray));
            const key = strToBytes(atob(json.keys[0].k));
            const kid = strToBytes(atob(json.keys[0].kid));
            /* tslint:enable no-unsafe-any */
            resolve(this._vid.webkitAddKey(this._key, key, kid, /* sessionId */ ""));
          } else {
            resolve(this._vid.webkitAddKey(this._key, license, null, /* sessionId */ ""));
          }
        } catch (err) {
          reject(err);
        }
      });
    };
  }

  generateRequest(_initDataType: string, initData: ArrayBuffer): Promise<void> {
    return new PPromise((resolve) => {
      this._vid.webkitGenerateKeyRequest(this._key, initData);
      resolve();
    });
  }

  close(): Promise<void> {
    return new PPromise((resolve) => {
      this._closeSession$.next();
      this._closeSession$.complete();
      resolve();
    });
  }

  load(): Promise<boolean> {
    return PPromise.resolve(false);
  }

  remove(): Promise<void> {
    return PPromise.resolve();
  }
}

class OldWebKitCustomMediaKeys implements ICustomMediaKeys {
  private readonly ks_: string;
  private _videoElement?: IOldWebkitHTMLMediaElement;

  constructor(keySystem: string) {
    this.ks_ = keySystem;
  }

  _setVideo(videoElement: IOldWebkitHTMLMediaElement|HTMLMediaElement): void {
    if (!isOldWebkitMediaElement(videoElement)) {
      throw new Error("Video not attached to the MediaKeys");
    }
    this._videoElement = videoElement;
  }

  createSession(/* sessionType */): ICustomMediaKeySession {
    if (this._videoElement == null) {
      throw new Error("Video not attached to the MediaKeys");
    }
    return new OldWebkitMediaKeySession(this._videoElement, this.ks_);
  }

  setServerCertificate(): Promise<void> {
    throw new Error("Server certificate is not implemented in your browser");
  }
}

export default function getOldWebKitMediaKeysCallbacks() {
  const isTypeSupported = function (keyType: string): boolean {
    // get any <video> element from the DOM or create one
    // and try the `canPlayType` method
    let videoElement = document.querySelector("video");
    if (videoElement == null) {
      videoElement = document.createElement("video");
    }
    /* tslint:disable no-unsafe-any */
    /* tslint:disable no-unbound-method */
    if (videoElement != null && typeof videoElement.canPlayType === "function") {
      /* tslint:enable no-unbound-method */
      return !!(videoElement as any).canPlayType("video/mp4", keyType);
      /* tslint:enable no-unsafe-any */
    } else {
      return false;
    }
  };
  const createCustomMediaKeys =
    (keyType: string) => new OldWebKitCustomMediaKeys(keyType);
  const setMediaKeys = (elt: HTMLMediaElement,
                        mediaKeys: MediaKeys|ICustomMediaKeys|null): void => {
    if (mediaKeys === null) {
      return;
    }
    if (!(mediaKeys instanceof OldWebKitCustomMediaKeys)) {
      throw new Error("Custom setMediaKeys is supposed to be called " +
                      "with old webkit custom MediaKeys.");
    }
    return mediaKeys._setVideo(elt);
  };
  return {
    isTypeSupported,
    createCustomMediaKeys,
    setMediaKeys,
  };
}

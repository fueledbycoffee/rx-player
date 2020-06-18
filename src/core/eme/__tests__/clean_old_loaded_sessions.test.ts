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

import { timer } from "rxjs";
import cleanOldLoadedSessions from "../clean_old_loaded_sessions";
import LoadedSessionsStore from "../utils/loaded_sessions_store";

/* tslint:disable no-unsafe-any */

const entry1 = [ { initData: new Uint8Array([1, 6, 9]),
                   initDataType: "test" } ];

const entry2 = [ { initData: new Uint8Array([4, 8]),
                   initDataType: "foo" } ];

const entry3 = [ { initData: new Uint8Array([7, 3, 121, 87]),
                   initDataType: "bar" } ];

function createLoadedSessionsStore() : LoadedSessionsStore {
  return {
    getLength() {
      return 3;
    },
    getAll() {
      return [entry1, entry2, entry3];
    },
    closeSession() {
      return timer(Math.random() * 50);
    },
  } as any;
}

const emptyLoadedSessionsStore = {
  getLength() { return 0; },
  getAll() { return []; },
  closeSession() { throw new Error("closeSession should not have been called"); },
} as any as LoadedSessionsStore;

/**
 * Call `cleanOldLoadedSessions` with the given loadedSessionsStore and
 * limit and make sure that:
 *   - no side-effect happen when running
 *   - nothing is emitted
 *   - it just complete without an error
 * Call `done` when done.
 * @param {Object} loadedSessionsStore
 * @param {number} limit
 * @param {Function} done
 */
function checkNothingHappen(
  loadedSessionsStore : LoadedSessionsStore,
  limit : number,
  done : () => void
) {
  const closeSessionSpy = jest.spyOn(loadedSessionsStore, "closeSession");
  let itemNb = 0;
  cleanOldLoadedSessions(loadedSessionsStore, limit).subscribe(
    () => { itemNb++; },
    () => { throw new Error("The Observable should not throw"); },
    () => {
      expect(itemNb).toEqual(0);
      expect(closeSessionSpy).not.toHaveBeenCalled();
      closeSessionSpy.mockRestore();
      done();
    }
  );
}

/**
 * Call `cleanOldLoadedSessions` with the given loadedSessionsStore, limit and
 * entries and make sure that:
 *   - closeSession is called on the specific entries a single time
 *   - all right events are received in the right order each a single time
 *   - it completes without an error
 * Call `done` when done.
 * @param {Object} loadedSessionsStore
 * @param {number} limit
 * @param {Array.<Object>} entries
 * @param {Function} done
 */
function checkEntriesCleaned(
  loadedSessionsStore : LoadedSessionsStore,
  limit : number,
  entries : any[],
  done : () => void
) {
  const closeSessionSpy = jest.spyOn(loadedSessionsStore, "closeSession");
  let itemNb = 0;
  const pendingEntries : any[] = [];
  cleanOldLoadedSessions(loadedSessionsStore, limit).subscribe(
    (evt) => {
      if (evt.type === "cleaning-old-session") {
        pendingEntries.push(evt.value);
      }
      itemNb++;
      if (itemNb <= entries.length) {
        expect(evt).toEqual({ type: "cleaning-old-session",
                              value: entries[itemNb - 1] });
      } else if (itemNb > entries.length * 2) {
        throw new Error("Too many received items: " + String(itemNb));
      } else {
        expect(evt.type).toEqual("cleaned-old-session");
        expect(pendingEntries).not.toHaveLength(0);
        expect(pendingEntries).toContainEqual(evt.value);
        pendingEntries.splice(pendingEntries.indexOf(evt.value), 1);
      }
    },
    () => { throw new Error("The Observable should not throw"); },
    () => {
      expect(pendingEntries).toEqual([]);
      expect(itemNb).toEqual(entries.length * 2);
      done();
    }
  );
  expect(closeSessionSpy).toHaveBeenCalledTimes(entries.length);
  for (let i = 0; i < entries.length; i++) {
    expect(closeSessionSpy)
      .toHaveBeenNthCalledWith(i + 1,
                               entries[i].initData,
                               entries[i].initDataType);
  }
      closeSessionSpy.mockRestore();
}

describe("core - eme - cleanOldLoadedSessions", () => {
  it("should do nothing with a negative limit", (done) => {
    checkNothingHappen(createLoadedSessionsStore(), -1, done);
    checkNothingHappen(createLoadedSessionsStore(), -20, done);
    checkNothingHappen(emptyLoadedSessionsStore, -20, done);
  });

  it("should do nothing with a limit equal to NaN", (done) => {
    checkNothingHappen(createLoadedSessionsStore(), NaN, done);
    checkNothingHappen(emptyLoadedSessionsStore, NaN, done);
  });

  it("should do nothing with a limit equal to -infinity", (done) => {
    checkNothingHappen(createLoadedSessionsStore(), -Infinity, done);
    checkNothingHappen(emptyLoadedSessionsStore, -Infinity, done);
  });

  it("should do nothing if the limit is superior to the current length", (done) => {
    checkNothingHappen(createLoadedSessionsStore(), 4, done);
    checkNothingHappen(createLoadedSessionsStore(), 5, done);
    checkNothingHappen(createLoadedSessionsStore(), 6, done);
    checkNothingHappen(createLoadedSessionsStore(), +Infinity, done);
    checkNothingHappen(emptyLoadedSessionsStore, 1, done);
    checkNothingHappen(emptyLoadedSessionsStore, 2, done);
    checkNothingHappen(emptyLoadedSessionsStore, 1000, done);
    checkNothingHappen(emptyLoadedSessionsStore, +Infinity, done);

  });

  it("should do nothing if the limit is equal to the current length", (done) => {
    checkNothingHappen(createLoadedSessionsStore(), 3, done);
    checkNothingHappen(emptyLoadedSessionsStore, 0, done);
  });

  it("should remove some if the limit is inferior to the current length", (done) => {
    checkEntriesCleaned(createLoadedSessionsStore(),
                        1,
                        [ entry1, entry2 ],
                        done);
    checkEntriesCleaned(createLoadedSessionsStore(),
                        2,
                        [ entry1 ],
                        done);
  });

  it("should remove all if the limit is equal to 0", (done) => {
    checkEntriesCleaned(createLoadedSessionsStore(),
                        0,
                        [ entry1, entry2, entry3 ],
                        done);
  });
});
/* tslint:enable no-unsafe-any */

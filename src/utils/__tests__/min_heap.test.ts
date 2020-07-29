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

import MinHeap from "../min_heap";

describe("utils - MinHeap", () => {
  it("should return undefined when calling `getMin` for a new MinHeap", () => {
    const minHeap = new MinHeap();
    expect(minHeap.getMin()).toEqual(undefined);
  });

  it("should return undefined when calling `pop` for a new MinHeap", () => {
    const minHeap = new MinHeap();
    expect(minHeap.pop()).toEqual(undefined);
  });

  it("should return the only element when calling `getMin` on a MinHeap with a unique element", () => {
    const elt = { priority: 4 };
    const minHeap = new MinHeap();
    minHeap.push(elt);
    expect(minHeap.getMin()).toEqual(elt);
  });

  it("should pop out the only element when calling `pop` on a MinHeap with a unique element", () => {
    const minHeap = new MinHeap();
    expect(minHeap.pop()).toEqual(undefined);
  });
});

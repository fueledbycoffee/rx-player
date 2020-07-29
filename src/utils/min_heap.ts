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
 * TypeScript implementation of a min-heap.
 * @class MinHeap
 */
export default class MinHeap<T extends { priority : number }> {
  public _arr : T[];

  constructor() {
    this._arr = [];
  }

  public getMin() : T | undefined {
    return this._arr[0];
  }

  public push(elt : T) {
    this._arr.push(elt);
    this._shiftUp(this._arr.length - 1);
  }

  public pop() : T | undefined {
    const elt = this._arr.pop();
    if (this._arr.length > 1) {
      this._shiftDown(0);
    }

    return elt;
  }

  private _shiftUp(startIndex : number) {
    let currentEltIdx = startIndex;
    const element = this._arr[currentEltIdx];
    while (currentEltIdx > 0) {
      const parentEltIdx = Math.floor((currentEltIdx + 1) / 2) - 1;
      const parentElt = this._arr[parentEltIdx];
      if (element.priority > parentElt.priority) {
        return;
      }

      // swap things up
      this._arr[parentEltIdx] = element;
      this._arr[currentEltIdx] = parentElt;
      currentEltIdx = parentEltIdx;
    }
  }

  private _shiftDown(startIndex : number) {
    let i = startIndex;
    while (true) {
      const child2Idx = (i + 1) * 2;
      const child1Idx = child2Idx - 1;
      if (this._arr.length <= child2Idx) {
        if (this._arr.length <= child1Idx) {
          return;
        }
        const currElt = this._arr[i];
        this._arr[i] = this._arr[child1Idx];
        this._arr[child1Idx] = currElt;
        return;
      }

      const lowestPriorityIdx = this._arr[child1Idx].priority <
                                this._arr[child2Idx].priority ?
        child1Idx :
        child2Idx;
      if ((this._arr[i]) > (this._arr[lowestPriorityIdx])) {
        const currElt = this._arr[i];
        this._arr[i] = this._arr[lowestPriorityIdx];
        this._arr[lowestPriorityIdx] = currElt;
        i = lowestPriorityIdx;
      } else {
        return;
      }
    }
  }
}

# Release v3.19.0 (2020-03-11) #################################################

## Overview ####################################################################

The v3.19.0 brings several new improvements:

  - the RxPlayer will now be able to consider multiple URL per segment (for DASH
    contents)

  - we've made several improvements related to the performance of the RxPlayer's
    Manifest parsing logic

  - we've added yet again another external tool (still experimental) called
    `createMetaPlaylist` which allows to easily concatenate multiple DASH/Smooth
    (or even MetaPlaylist!) contents into a single MetaPlaylist content

  - the RxPlayer now exports more types (for TypeScript) related to audio /
    video / text track choices, with 6 new types

  - we fixed several minor issues. Most being related to recently released
    experimental tools and features



## Multiple URLs per segment ###################################################

DASH's MPD can declare multiple URL per segment through the declaration of
multiple BaseURL elements.

This allows for example to fallback to another CDN when the main one become
unavailable. It may also sometimes be used when a first source might not have
all media segments yet.

The strategy taken by the RxPlayer when encountering multiple URL linked to a
segment is the following:
  1. It will try to request the first URL (the one described by the first
     BaseURL element encountered in the MPD)
  2. If it fails, it will immediately request the second URL
  3. If it also fail, it will immediately request the third one, and so on
  4. If all URL fails, the usual retry logic starts: depending on your
     configuration, the RxPlayer will wait a small delay - which will grow
     exponentially each time the batch of requests fails - and after that delay
     it will try again to request each URL, one immediately after another (it's
     actually a little smarter than that, only requests which have failed with
     an error considered as retry-able will be retried. e.g., an URL returning
     an HTTP 403 Forbidden will not be retried).
  5. If all requests have failed and either:
    - we have done the maximum number of retry configured
    - or all URLs failed on an error that the RxPlayer judged as not retry-able
      (like a 403)
  Then, the player will stop on error and emit the usual `PIPELINE_LOAD_ERROR`
  error event

So basically, the usual retry logic is not done between different URL (as those
will usually be linked to different CDNs). All requests are batched together and
the retry logic is done when all this batch fails.

This was done as it seems the most logical way to go with such use cases.

Please open an issue if that behavior does not suit you. In that case we will
see whether we could update it or at least add supplementary configuration
options to adapt to it.



## Manifest parsing improvements ###############################################

Many changes in this release are linked to performance improvements on the
RxPlayer's Manifest-parsing logic.

We tried to:
  1. reduce the time taken by the RxPlayer to parse a Manifest
  2. do that parsing logic less often
  3. split that work in multiple parts, so we avoid blocking the main thread for
     too long


### but why? ###################################################################

We were confronted to the need to improve on those points because we were having
performance issues on some "embedded" devices (more specifically on devices with
low memory such as low-end set-top-boxes and limited devices like the
ChromeCast).

This was also linked to the fact that Canal+ Group - the company which started
the RxPlayer development and which employs the main RxPlayer contributors -
distributes live DASH contents with a pretty big timeshift window (usually set
to 8 hours).

We think that huge Manifests like those is _in fine_ a good thing for end users,
because it means an increased possibility to seek in previously broadcasted
contents - contents which may not be available elsewhere.

Moreover, we just feel that it should be part of our job to better handle large
contents without issues  -  much like we consider it would be part of the job of
a text editor to handle large enough text files while still being fully usable
(not thinking about any editor in particular here, this is just a - perhaps
loosy - analogy).

After this long introduction to why we did some improvements let's jump into
what we did.


### Doing updates through a "shorter" Manifest through `manifestUpdateUrl` #####

One of the most effective change we did to reduce Manifest parsing time (more
specifically update time for live contents) was to allow the consideration of
two version of the Manifest for the same content:
  1. The regular full Manifest
  2. A shortened version of it with a smaller timeshift window

This sadly means that, to profit from that improvement, you will surely need to
update the packaging logic of your streams.

But rest assured: the content does not have to be re-encoded. Both Manifest stay
linked to the same content, just the size of their timeshift window change (such
as DASH's timeShiftBufferDepth attribute).

In the RxPlayer, the first version of the Manifest (the full one) will in most
cases only be used to perform the initial load of the content. It also may need
to be requested at other times, e.g. when the RxPlayer thinks that its internal
Representation of it is completely out-of-sync, but those cases are very rare
and will in most cases not happen.

For regular Manifest updates, if needed, the RxPlayer will only request the
shorter version.
Because it will still have information about newly generated segments from it
and because the RxPlayer can just "guess" which old segments are not available
anymore, no information will be lost compared to when the RxPlayer use the full
version instead - as it did until now and still do if no short version of the
Manifest is provided.

This optimization has a huge effect on performance. To simplify, we could say
that the more there is a size difference between the full and the short version,
the more that improvement grows.

Still, it does not improve the initial load time, as it only impacts Manifest
updates.

If you want to profit from that optimization, you will have to set in
`loadVideo` the new `transportOptions` property called `manifestUpdateUrl`.
Every properties from `transportOptions` are documented
[here](https://developers.canal-plus.com/rx-player/doc/pages/api/loadVideo_options.html#subchapter-transportOptions)


### DASH "lazy-parsing" ########################################################

The RxPlayer will now only parse some parts of a DASH MPD at the time it needs
them.
For example, only Period that it plays and only AdaptationSets (tracks) that it
needs will be parsed, the rest won't be until we switch to the corresponding
Period or AdaptationSet.

We called this behavior "lazy-parsing" as it is inspired from the [lazy
evaluation](https://en.wikipedia.org/wiki/Lazy_evaluation) concept we can find
in programming languages like Haskell.

It is generally beneficial but has some setbacks:

  - the RxPlayer still needs a lot of information at parsing time, meaning that
    in many cases the improvement will be minimal (for example, it might need to
    parse every SegmentTimeline element in the last Period to calculate the
    available "edge" of a live content)

  - the code become less predictable when it comes to performance issues. We
    could now be in a case where a simple harmless function call can trigger
    that lazy-parsing and lead us to several seconds of parsing (in the worst
    cases)

We found that this new behavior provided the most improvements on contents with
multiple Periods. The more Periods a DASH MPD contained, the better the
improvement was.

Also, we saw visible improvements with both the initial loading time as well as
Manifest updates. This also can have an effect on VoD contents (as long as those
have multiple Periods, which is usually not the case).

As this feature is always on, there is no option linked to it. As long as you
have the right version, you will profit from it.


### Adaptive delay between Manifest updates ####################################

While investigating what we could do to improve our performance on embedded device. we at first looked at what other DASH video players were doing.

One interesting thing we were seeing is that the shaka-player, another open-source player, didn't have as much trouble playing Canal+ DASH streams than the RxPlayer had.
The curious thing is that, by looking at their MPD-parsing logic, we didn't see much differences to ours in terms of efficiency. The improvement had to be from elsewhere.

After several false lead on how they were doing it, we finally spotted the main reason: a reduction in the frequency of MPD updates. On the shaka-player, when parsing the MPD took too much time, the next updates could be postponed. For example, instead of refreshing our Manifest every 2 or 3 seconds (a low interval, but that's how our contents were), they were on some devices doing it every 12 seconds.

This was a pretty smart thing to do.
On some devices, the RxPlayer spent almost all its time parsing the MPD, leading to visible repercussion on content playback (which appeared jerky), the delay after which user interactions were taken into account and the stability of the device as a whole.

The RxPlayer has now integrated a similar logic, where long parsing time can raise the delay we will wait until we do the next Manifest update.


### What's next? ###############################################################

All those improvements lead to a much better experience on low-end devices.
But we can still do better, most notably for the initial loading time which can still be long for some type of contents.

To improve in that regard, we are still doing experimentation.
For example we're looking if we can even improve the impact lazy-parsing can have and even the possibility of using webassembly on the Manifest-parsing logic.

This is however still in an experimental stage and we cannot tell with certitude that such features will be available in future versions.

## `createMetaplaylist` tool

A new experimental tool, `createMetaplaylist` has been added.

This is a function allowing to create Metaplaylist contents - which are a concatenation of multiple DASH and/or Smooth contents - directly from a given list of Manifest. For more information on Metaplaylist contents, you can look at [the corresponding documentation page](https://developers.canal-plus.com/rx-player/doc/pages/api/metaplaylist.html).

Behind the hood, the main thing this function does is to extract the duration from every given content, and then generate a Metaplaylist object concatenating them with the right timing information.

Here is an example of how it can be used:
```js
import { createMetaplaylist } from "rx-player/experimental/tools";

createMetaplaylist(
    [
        {
            url: "https://somedashcontent.mpd",
            transport: "dash",
        },
        {
            url: "https://somesmoothcontent.ism/Manifest",
            transport: "smooth",
        },
        {
            url: "https://somemetaplaylistcontent.json",
            transport: "metaplaylist",
        }
    ]
).then(metaPlaylist => {
  console.log("generated Metaplaylist:", metaPlaylist);
});
```

The documentation on that tool can be found [here](https://developers.canal-plus.com/rx-player/doc/pages/api/createMetaplaylist.html).

## New exported types

The RxPlayer now exports 6 new TypeScript types related to track management.
This was an asked features by our users.

Here is their list:
  - `IAvailableAudioTrack`/ `IAvailableTextTrack` / `IAvailableVideoTrack`: those types define a single track definition as returned respectively by the `getAvailableAudioTracks`, the `getAvailableTextTracks` and the `getAvailableVideoTracks` methods

  -  `IAudioTrack`/ `ITextTrack` / `IVideoTrack`: those types define the current track returned by methods and events communicating them. Respectively we're talking about `getAudioTrack` and the `audioTrackChange` event, `getTextTrack` and the `textTrackChange` event and `getVideoTrack` and the `videoTrackChange` event.

Every types exported by the RxPlayer is documented [here](https://developers.canal-plus.com/rx-player/doc/pages/api/exported_types.html).



## Changelog ###################################################################

### Features ###################################################################

  - dash: handle multiple URL per segment anounced through multiple BaseURL
    elements in the MPD
  - dash/smooth/metaplaylist: add `manifestUpdateUrl` to loadVideo's
    `transportOptions` to provide a shorter version of the Manifest, used for
    more resource-efficient Manifest updates
  - tools/createMetaplaylist: add the experimental `createMetaplaylist` tool,
    which allows to generate Metaplaylist contents from given Manifests
  - tools/TextTrackRenderer: add the optional `language` property to the
    `setTextTrack` method of the experimental `TextTrackRenderer` tool as it
    could be needed when parsing SAMI subtitles
  - types: export `IAvailableAudioTrack`, `IAvailableTextTrack` and
    `IAvailableVideoTrack` types
  - types: export `IAudioTrack`, `ITextTrack` and `IVideoTrack` types


### Bug fixes ##################################################################

  - dash/smooth: fix segment url resolution when there is query parameters in the Manifest URL and/or segment path, themselves containing "/" characters
  - local-manifest: fix videoElement's duration and `getVideoDuration` for contents in the experimental `local` transport
  - tools/parseBifThumbnails: do not return an un-displayable ArrayBuffer of the whole thing in each `image` property in the experimental `parseBifThumbnails` function


### Other improvements #########################################################

  - compat: avoid pushing a segment on top of the current position in Safari, as it can sometime lead to green macro-blocks
  - dash: add multiple performance improvements related to MPD parsing on embedded devices
  - dash/smooth/metaplaylist/local: refresh less often the Manifest when parsing it takes too much time to improve performance
  - smooth: filter unsupported video and audio QualityLevels when parsing a Smooth Manifest
  - build: greatly reduce the time needed to produce a modular build through the `npm run build:modular` script
  - build: remove Object.assign dependency

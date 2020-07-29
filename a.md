# SegmentsFetcher ##############################################################

## Overview ####################################################################

The `SegmentsFetcher` abstracts to the player the task of downloading media
segments.

It acts basically as a request scheduler: You give the list of segment that you
want, in the order you want them, it schedules request for them respecting your
list order and gives back to you events to indicate:
  - when segment requests begin or finish
  - metrics about those requests (which can be useful to calculate the user's
    bandwidth - for example)
  - and, of course, the segments' data

Because it directly asks for new segment downloads, the SegmentsFetcher code
interacts with the `transports` code - whose task is to implement the streaming
protocol.



## Segment Queues ##############################################################

The `SegmentsFetcher` allows the creation of "Segment Queues".

A "Segment Queue" - as its name hints at - is an object which contains a queue
of segments that you want to download.
When "started", the Segment Queue will begin to load segments:
The first segment in its queue is downloaded. When it is completely loaded and
parsed, it is removed from the queue and the next segment in that queue is
downloaded.

Because in a media player, you often want to download segments from different
type of media (audio, video, text etc.) in parallel, you usually create one
segment queue per type, which will all be running concurrently.

This can be represented as such:
```
Segment Queues --------------------------------------------------------------
        +-----------+  +-------------+  +-------------+  +-------------+
Audio   |  Segment  |  |   Segment   |  |   Segment   |  |   Segment   |
        |  Audio N  |  |  Audio N+1  |  |  Audio N+3  |  |  Audio N+3  |
        +-----------+  +-------------+  +-------------+  +-------------+

        +-----------+  +-------------+  +-------------+  +-------------+
Video   |  Segment  |  |   Segment   |  |   Segment   |  |   Segment   |
        |  Video N  |  |  Video N+1  |  |  Video N+3  |  |  Video N+3  |
        +-----------+  +-------------+  +-------------+  +-------------+

        +-----------+  +-------------+  +-------------+  +-------------+
Text    |  Segment  |  |   Segment   |  |   Segment   |  |   Segment   |
        |  Text  N  |  |  Text  N+1  |  |  Text  N+3  |  |  Text  N+3  |
        +-----------+  +-------------+  +-------------+  +-------------+
-----------------------------------------------------------------------------
```

In this example, we have three parallel queues each for 4 segments.
Here, we will be downloading concurrently an audio segment, a video segment and
a text segment.

It's important to consider that all three of those Segment Queues run
concurrently. Most of the time (the exception being described in the next part),
the audio queue won't wait for the video queue to download its next segment.



## Segment priorities ##########################################################

But downloading in parallel an audio, a video and/or a text segment might not
always be what you want.

For example, you could be in a situation where the player has plenty of video
and text segments in advance in its buffer but needs an audio segment
immediately.

Here is a visual example for when an audio segment is immediately needed:
```
Buffers ----------------------------------------------------------------------

Audio |===================|                                             |
Video |===================|========================                     |
Text  |===================|==============================               |
      0            current position                                   1min30

 -----------------------------------------------------------------------------

I here try to visually represent an audio, video and text buffer relative to
the media timeline.

In this example, we can see that an audio segment is immediately needed whereas
there is already enough video and text data.
```

In this situation, we would prefer to actually only download the audio segment,
so we can profit from the full user's bandwidth and get it faster than if we
were downloading other segments at the same time.
That's where segment priorities come into play.

When a segment is added to a Segment Queue, it is actually added with a priority
number: lower is that number (starting at `0`), the higher is that segment's
priority.

When a Segment Queue consider its next segment, it also looks at the priority
of the concurrent Segment Queues's next segment. Only the segment with the
highest priority between all of them (the lowest priority number) will be
requested.

If multiple Segment Queues have the same priority for their next segment, the
segments are requested in parallel. This situation happens very often.


### High priorities ############################################################

There is a last concept to grasp which is that some segments have a "high
priority".

Let's consider our previous example:
```
Buffers ----------------------------------------------------------------------

Audio |===================|                                             |
Video |===================|========================                     |
Text  |===================|==============================               |
      0            current position                                   1min30

 -----------------------------------------------------------------------------
 ```

 Now let's imagine that at the time we got into this situation, we were already
 downloading the next video segment.

 The previously-described priority rules normally won't impact segment requests
 that have already begun. As such, that video segment requests won't normally be
 cancelled.
 This is because in most cases, we don't want to cancel a request: this would be
 just be a waste of bandwidth.

 But because they are situations like this one where it is actually better to
 cancel requests, there's an exception: A segment with a very high priority (a very
 low priority number [1]) has the added consequence of "interrupting" segment
 requests for segments which have a low priority (a high priority number [1]).

 The corresponding segments with low priority will be requested when they become
 those with the highest priority (the lowest priority number).

 [1] Note: Both the "very high" and the "low" values are configurable.



## Evolution of segments and priorities ########################################

As the playback progress segment previously with a low priority progressively
become higher priority. Other playback events, such as a seek might also
completely change the priority for each segments and might even change the
whole list of wanted segments.

For these reasons, it is possible to update the queue of a Segment Queue at
any time.
A Segment Queue contain intelligence to find what actually changed when its
queue is updated (was it just priority changes? Was the list of segment
updated?).

For example, if a completely different segment is now found at first place in
this new queue, the Segment Queue might abort its current segment request and
start a new one for that one instead.



## Segment Queue termination ###################################################

In some situation, you just want a Segment Queue to finish its current download
and stop when it is done.

This for example a frequent behavior when switching the current quality for a
given media type:
  1. you finish the downloads for the current quality
  2. you start a new queue with segments in the new quality

To that effect, Segment Queue have a "termination" concept, where it is
possible to ask them to end as soon as possible, while stile giving them time
to finish a possible pending request.

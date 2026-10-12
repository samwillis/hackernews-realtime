import { LiveLink as Link } from "./live-link";
import type { Story } from "@/lib/types";
import type { RowChange } from "@/lib/changes";
import { discussionLink } from "@/lib/comments";
import {
  age,
  articleLink,
  decodeTitle,
  domain,
  HN,
  itemLink,
  userLink,
} from "@/lib/links";
export function ChangedValue({
  value,
  stamp,
  field,
}: {
  value: string | number;
  stamp?: number;
  field: string;
}) {
  return (
    <span
      key={stamp ?? 0}
      data-change={stamp ? field : undefined}
      className={stamp ? "changed-value" : undefined}
    >
      {value}
    </span>
  );
}
export function StoryRow({
  story,
  change,
  now,
  thread = false,
}: {
  story: Story;
  change?: RowChange;
  now: number;
  thread?: boolean;
}) {
  const site = domain(story.url);
  const comments = (
    <>
      <ChangedValue
        value={story.comments}
        stamp={change?.fields.comments}
        field="comments"
      />{" "}
      comment{story.comments === 1 ? "" : "s"}
    </>
  );
  return (
    <>
      <div className="story-main">
        {!thread && <span className="rank">{story.rank}.</span>}
        <a
          className={`vote ${story.type === "job" || !story.title ? "no-vote" : ""}`}
          href={itemLink(story.item_id)}
          aria-label={`Vote on ${decodeTitle(story.title) || "[deleted]"} at Hacker News`}
        >
          <span />
        </a>
        <span className="titleline">
          <a
            className="story-title"
            href={articleLink(story.url, story.item_id)}
          >
            <ChangedValue
              value={decodeTitle(story.title) || "[deleted]"}
              stamp={change?.fields.title}
              field="title"
            />
          </a>
          {site && (
            <span className="domain">
              {" "}
              (
              <a href={`${HN}/from?site=${encodeURIComponent(site)}`}>{site}</a>
              )
            </span>
          )}
        </span>
      </div>
      <div className="subtext">
        {story.type !== "job" && (
          <>
            <ChangedValue
              value={story.score}
              stamp={change?.fields.score}
              field="score"
            />{" "}
            point{story.score === 1 ? "" : "s"}
            {story.author && (
              <>
                {" "}
                by <a href={userLink(story.author)}>{story.author}</a>
              </>
            )}{" "}
          </>
        )}
        <a href={itemLink(story.item_id)}>{age(story.created, now)}</a>
        {story.type !== "job" && (
          <>
            <span> | </span>
            {thread ? (
              <a href="#comments">{comments}</a>
            ) : (
              <Link prefetch={false} href={discussionLink(story.item_id)}>
                {comments}
              </Link>
            )}
          </>
        )}
      </div>
    </>
  );
}

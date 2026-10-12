import { notFound } from "next/navigation";
import {
  commentQuery,
  sealComments,
  sealStory,
  storyQuery,
} from "@/lib/queries";
import { parseStoryId, sortComments } from "@/lib/comments";
import { CommentsClient } from "./comments-client";
export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  let id: number;
  try {
    id = parseStoryId(params.id);
  } catch {
    notFound();
  }
  const stories = await storyQuery(id);
  if (!stories.length) notFound();
  const [comments, storyQuerySealed, commentsQuerySealed] = await Promise.all([
    commentQuery(id),
    sealStory(id),
    sealComments(id),
  ]);
  return (
    <CommentsClient
      key={id}
      initialStories={stories}
      initialComments={sortComments(comments)}
      queries={{ story: storyQuerySealed, comments: commentsQuerySealed }}
      initialNow={Date.now()}
    />
  );
}

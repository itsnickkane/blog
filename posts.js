// Add your posts here. Each post is an object:
// id        – unique slug used in the URL (?post=id)
// title     – post title
// date      – "Month DD, YYYY"
// tags      – optional array of tag strings
// content   – HTML string for the post body
//
// To embed a video anywhere in the content, use the helper tags:
//   <youtube id="VIDEO_ID" caption="Optional caption" />
//   <vimeo id="VIDEO_ID" caption="Optional caption" />
//   <loom id="VIDEO_ID" caption="Optional caption" />
//   <vidurl src="https://..." caption="Optional caption" />  ← any iframe-embeddable URL

const SITE_TITLE = "Nick's Blog";
const SITE_TAGLINE = "Writing on things that interest me.";

const POSTS = [
  {
    id: "welcome",
    title: "Welcome to the Blog",
    date: "June 5, 2026",
    tags: ["meta"],
    content: `
      <p>This is my new blog. I'll write about things I find interesting — technology, ideas, and whatever else catches my attention.</p>
      <p>Here's an example YouTube embed:</p>
      <youtube id="dQw4w9WgXcQ" caption="A classic." />
      <p>And a Vimeo embed:</p>
      <vimeo id="76979871" caption="Vimeo example." />
      <p>More posts coming soon.</p>
    `,
  },
  {
    id: "video-demo",
    title: "Embedding Videos from Any Source",
    date: "June 4, 2026",
    tags: ["demo"],
    content: `
      <p>The blog supports embedding videos from multiple sources. Here's how to use each one.</p>
      <h2>YouTube</h2>
      <p>Use the <code>&lt;youtube id="VIDEO_ID" /&gt;</code> tag with the ID from the URL.</p>
      <youtube id="jNQXAC9IVRw" caption="Me at the zoo — the first YouTube video." />
      <h2>Vimeo</h2>
      <p>Use <code>&lt;vimeo id="VIDEO_ID" /&gt;</code> with the numeric ID.</p>
      <vimeo id="148751763" caption="Vimeo staff pick example." />
      <h2>Loom</h2>
      <p>Use <code>&lt;loom id="VIDEO_ID" /&gt;</code> with the Loom share ID.</p>
      <h2>Any URL</h2>
      <p>For anything else (Wistia, Bunny, custom players), use <code>&lt;vidurl src="https://..." /&gt;</code>.</p>
      <hr />
      <p>That's all there is to it. Edit <code>posts.js</code> to add your own posts.</p>
    `,
  },
];

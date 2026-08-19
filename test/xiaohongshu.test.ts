import { describe, expect, it } from "vitest";
import { extractPublicXiaohongshuNotes, XiaohongshuConnector } from "../src/main/xiaohongshu";
import type { Source } from "../src/shared/types";

const source: Source = {
  id: "xhs-source",
  url: "https://www.xiaohongshu.com/user/profile/author_1234",
  title: "小红书 · 测试", kind: "xiaohongshu", connectorId: "xiaohongshu", status: "active", pollingEnabled: true,
  consecutiveEmpty: 0, failureCount: 0, createdAt: 1, updatedAt: 1
};

const profileHtml = `<html><body><script type="application/json" id="SSR_DATA">{
  "pageProps":{"notes":[
    {"noteId":"note_12345678","title":"公开笔记标题","desc":"这是公开笔记摘要","createTime":1787000000000,"user":{"nickname":"测试作者"},"cover":{"urlDefault":"https://ci.example.test/cover.jpg"}},
    {"noteCard":{"noteId":"note_87654321","displayTitle":"另一篇笔记","desc":"第二篇摘要","time":"2026-08-18","userInfo":{"nickName":"测试作者"},"imageList":[{"urlPre":"https://ci.example.test/cover-2.jpg"}]}}
  ]}}</script></body></html>`;

describe("Xiaohongshu public profile connector", () => {
  it("extracts only structured public note cards without executing page scripts", () => {
    expect(extractPublicXiaohongshuNotes(profileHtml, source.url)).toMatchObject([
      { externalId: "note_12345678", title: "公开笔记标题", author: "测试作者", url: "https://www.xiaohongshu.com/explore/note_12345678" },
      { externalId: "note_87654321", title: "另一篇笔记", author: "测试作者", imageUrl: "https://ci.example.test/cover-2.jpg" }
    ]);
  });

  it("also reads a public hydration assignment as JSON text without evaluating it", () => {
    const hydrated = `<script>window.__INITIAL_STATE__ = {"notes":[{"noteId":"note_24681357","title":"Hydrated card","user":{"nickname":"Author"}}]}; alert('must not run')</script>`;
    expect(extractPublicXiaohongshuNotes(hydrated, source.url)).toMatchObject([
      { externalId: "note_24681357", title: "Hydrated card", author: "Author" }
    ]);
  });

  it("keeps an empty or gated public profile actionable rather than reporting a healthy empty sync", async () => {
    const connector = new XiaohongshuConnector({ getText: async () => ({ url: source.url, status: 200, contentType: "text/html", text: "<html></html>" }) } as never);
    await expect(connector.sync({ source, subscription: { id: source.id, sourceId: source.id, connectorId: "xiaohongshu", config: {}, createdAt: 1, updatedAt: 1 } })).rejects.toThrow("不会使用 Cookie、登录态或反爬绕过");
  });
});

import { expect, it } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { withArticleDocument } from "../src/main/article-document";
const settings = { provider: "deepseek" as const, model: "fixture", effort: "default" };
it("atomically reconciles current original, language, rewrite and card owners without deleting shared or late-safe resources", () => {
    const db = new ReadingDatabase(":memory:");
    try {
        const source = db.createSource({ url: "https://example.com/feed", title: "Feed", kind: "rss", pollingEnabled: true });
        const entry = { id: "entry", sourceId: source.id, url: "https://example.com/post", canonicalUrl: "https://example.com/post", title: "Fixture", contentHash: "hash", createdAt: 1, read: false, favorite: false, imageUrl: "https://example.com/cover.png" };
        db.saveEntries([entry, { ...entry, id: "other", url: "https://example.com/other", canonicalUrl: "https://example.com/other" }]);
        const body = (id: string, images: string[]) => withArticleDocument({ entryId: id, url: entry.url, title: entry.title, renderProfile: "standard", contentHtml: '<p>Saved body</p>' + images.map(name => `<img src="https://example.com/${name}.png">`).join("") });
        db.articles.save(entry.id, body(entry.id, ["old", "rewrite"]));
        db.articles.save(entry.id, body(entry.id, ["language"]), "language");
        db.articles.save("other", body("other", ["old"]));
        const old = "https://example.com/old.png", image = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
        db.articles.saveImage(entry.id, old, image);
        db.articles.saveImage("other", old, image);
        const job = db.rewrites.enqueue(entry.id, settings);
        db.rewrites.progress(job, 1, 1);
        db.rewrites.finish(job, { markdown: "中文正文 ![图](https://example.com/rewrite.png)", provider: "deepseek", model: "fixture", createdAt: 1, sourceUrl: entry.url, sourceTitle: entry.title, sourceHash: "hash", promptVersion: 1 });
        db.articles.save(entry.id, body(entry.id, ["new"]));
        expect(db.articles.ownsImage(entry.id, old)).toBe(false);
        expect(db.articles.image("other", old)).toBe(image);
        expect(db.articles.pendingMedia().map(row => row.url)).not.toContain(old);
        for (const name of ["new", "language", "rewrite", "cover"])
            expect(db.articles.ownsImage(entry.id, `https://example.com/${name}.png`)).toBe(true);
        db.articles.saveImage(entry.id, old, image);
        expect(db.articles.image(entry.id, old)).toBeUndefined();
        db.rewrites.remove(entry.id);
        expect(db.articles.ownsImage(entry.id, "https://example.com/rewrite.png")).toBe(false);
        const saved = db.articles.read(entry.id)!;
        expect(saved.document).toBeDefined();
        expect(saved.contentHtml).toBe("");
        expect(db.articles.read(entry.id, "", true)?.contentHtml).toContain("new.png");
    }
    finally {
        db.close();
    }
});
it("does not parse already saved bodies when only unchanged feed card metadata is refreshed", () => {
    const db = new ReadingDatabase(":memory:");
    try {
        const source = db.createSource({ url: "https://example.com/feed", title: "Feed", kind: "rss", pollingEnabled: true });
        const entry = { id: "entry", sourceId: source.id, url: "https://example.com/post", canonicalUrl: "https://example.com/post", title: "Fixture", contentHash: "hash", createdAt: 1, read: false, favorite: false };
        db.saveEntries([entry]);
        db.articles.save(entry.id, withArticleDocument({ entryId: entry.id, url: entry.url, title: entry.title, renderProfile: "standard", contentHtml: '<p>Saved body</p><img src="https://example.com/owned.png">' }));
        let calls = 0;
        const reconcile = db.articles.reconcileMedia.bind(db.articles);
        db.articles.reconcileMedia = id => { calls++; reconcile(id); };
        db.saveEntries([{ ...entry, title: "Updated metadata" }]);
        expect(calls).toBe(0);
        expect(db.articles.ownsImage(entry.id, "https://example.com/owned.png")).toBe(true);
    }
    finally {
        db.close();
    }
});
it("ignores an unsafe metadata cover and keeps unknown owners without blocking new proven images",()=>{
 const db=new ReadingDatabase(":memory:");
 try{
  const source=db.createSource({url:"https://example.com/unsafe-cover",title:"Fixture",kind:"rss",pollingEnabled:true});
  const entry={id:"entry",sourceId:source.id,url:"https://example.com/post",canonicalUrl:"https://example.com/post",title:"Fixture",contentHash:"hash",createdAt:1,read:false,favorite:false,imageUrl:"javascript:unsafe"};db.saveEntries([entry]);
  db.articles.registerImage(entry.id,"https://example.com/unknown-owner.png",entry.url);
  (db as any).db.prepare("INSERT INTO article_documents(entry_id,variant,snapshot_json,quality,saved_at) VALUES(?,?,?,?,?)").run(entry.id,"future",JSON.stringify({url:entry.url,document:{version:999}}),2,1);
  const snapshot=(db as any).db.prepare("SELECT snapshot_json FROM article_documents WHERE variant='future'").get().snapshot_json;
  db.articles.save(entry.id,withArticleDocument({entryId:entry.id,url:entry.url,title:entry.title,renderProfile:"standard",contentHtml:'<p>Saved body</p><img src="https://example.com/new-valid.png">'}));
  expect(db.articles.ownsImage(entry.id,"https://example.com/new-valid.png")).toBe(true);expect(db.articles.ownsImage(entry.id,"https://example.com/unknown-owner.png")).toBe(true);expect(db.articles.pendingMedia().map(row=>row.url)).not.toContain("javascript:unsafe");
  expect((db as any).db.prepare("SELECT snapshot_json FROM article_documents WHERE variant='future'").get().snapshot_json).toBe(snapshot);
 }finally{db.close();}
});

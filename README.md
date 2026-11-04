# HERO-MINECRAFT-DATABASE

قاعدة بيانات Minecraft Bedrock (عربي/إنجليزي) + خادم **MCP** لربطها مع Claude + محرر فيديو عمودي تلقائي (1080×1920، 9:16).

```
database/      items.json  blocks.json  mobs.json  recipes.json
images/        items/ blocks/ mobs/      ← ضع هنا صورك الخاصة (تتقدّم على الروابط) أو نزّل الصور بالسكربت
shared/        db.ts                      ← التحميل + البحث العربي/الإنجليزي (مشترك)
mcp-server/    server.ts                  ← خادم MCP (stdio + HTTP) بلا أي اعتماديات وقت التشغيل
video-editor/  editor.ts                  ← صوت + توقيتات → MP4 مع أنيميشن (يستخدم FFmpeg)
scripts/       validate-db.ts  images.ts
tests/         14 اختبار (node:test)
```

## ⚠️ ما تم اختباره وما لم يُختبر (بصراحة)

| الجزء | الحالة |
|---|---|
| البحث عربي/إنجليزي، قواعد JSON، `validate` | ✅ مُختبر (اختبارات آلية) |
| خادم MCP عبر stdio وHTTP (بروتوكول JSON-RPC مكتوب يدوياً) | ✅ مُختبر بعميل اختبار مكتوب داخل المشروع |
| محرر الفيديو: تصيير MP4 حقيقي، فحص الأبعاد 1080×1920 و9:16 وH.264+AAC، وظهور الصورة وحركتها في الإطارات | ✅ مُختبر بصوت وصور اختبارية (FFmpeg 6.1) |
| **روابط الصور** | ⚠️ **لم تُتحقق** — بيئة الإنشاء بلا إنترنت. المسارات مبنية على بنية مستودع Mojang الرسمي `Mojang/bedrock-samples`. شغّل `npm run images:verify` (أو CI على GitHub) وصحّح أي مسار يفشل |
| `npm install` وبناء Docker | ⚠️ لم يُشغَّل هنا (لا إنترنت/لا Docker). اختُبر `tsc` والتشغيل بنسخ محلية من TypeScript وtsx |
| الاتصال الفعلي بتطبيق Claude Desktop / claude.ai | ⚠️ لم يُجرَّب. الخادم يتبع مواصفات MCP لكن اربطه وجرّبه عندك |

حدود يجب أن تعرفها:
- قاعدة البيانات **نواة صغيرة حقيقية**: 20 عنصراً، 22 بلوكاً، 13 موب، 17 وصفة. توسّعها بإضافة مدخلات إلى ملفات JSON ثم `npm run validate`.
- الأسماء العربية شائعة الاستخدام وليست بالضرورة ترجمة Mojang الرسمية حرفياً — راجعها.
- صور الموبات هي **خامات الجلد (skin textures)** وليست صور بورتريه جميلة. للحصول على صور أنسب ضع PNG باسم الموب في `images/mobs/<id>.png` (مثلاً `creeper.png`) وسيُستخدم تلقائياً.
- المحرر **لا يحوّل الكلام إلى نص**. تحديد توقيت الظهور يتم من ملف `cues.json` أو من ترجمة SRT/JSON بها توقيت (مثلاً من Whisper).
- حقوق الصور: خامات Minecraft ملك Mojang/Microsoft. راجع رخصة المستودع وإرشادات الاستخدام قبل أي استخدام تجاري/ربحي.

## التشغيل

المتطلبات: Node.js 20+ ، وFFmpeg للفيديو فقط.

```bash
npm install
npm run validate          # فحص قاعدة البيانات
npm test                  # الاختبارات
npm run images:verify     # فحص روابط الصور (يحتاج إنترنت)
npm run images:download   # تنزيل الصور إلى images/ (يحتاج إنترنت)
```

## ربط خادم MCP مع Claude

**محلياً (Claude Desktop):** أضف إلى ملف الإعدادات:
```json
{
  "mcpServers": {
    "hero-minecraft": {
      "command": "npx",
      "args": ["tsx", "/المسار/الكامل/HERO-MINECRAFT-DATABASE/mcp-server/server.ts"]
    }
  }
}
```
أو بعد `npm run build`: `"command": "node", "args": [".../mcp-server/dist/mcp-server/server.js"]`.

**Claude Code:** `claude mcp add hero-minecraft -- npx tsx /المسار/mcp-server/server.ts`

**عن بُعد (هاتف/سحابة):** شغّل وضع HTTP (`npm run mcp:http`) أو انشره بـ Docker، ثم استخدم الرابط `https://موقعك/mcp`.
طبّق `MCP_AUTH_TOKEN` دائماً على أي خادم عام. تطبيق الهاتف لا يشغّل خوادم محلية، لذا يحتاج خادماً عاماً عبر HTTPS.

الأدوات: `search_minecraft` · `get_entry` · `get_recipe` · `get_image` · `list_entries` · `database_stats`

## محرر الفيديو

```bash
# 1) توقيتات يدوية
npm run render -- --audio voice.mp3 --cues video-editor/examples/cues.example.json --out output/video.mp4

# 2) توقيتات تلقائية من ترجمة بها زمن (SRT / VTT / JSON)
npm run render -- --audio voice.mp3 --transcript voice.srt --save-cues cues.json --out output/video.mp4

# معاينة الجدول بدون تصيير
npm run render -- --audio voice.mp3 --transcript voice.srt --dry-run
```

- حركات: `pop` (ارتداد) · `zoom` · `slide-up` · `slide-left` · `fade` — مع ظهور/اختفاء تدريجي وطفو خفيف.
- المخرج: MP4، H.264 + AAC، `yuv420p`، 1080×1920، 30fps، `faststart`.
- الصور بدقة صغيرة (16px) تُكبَّر بـ nearest-neighbor للحفاظ على حدّة البكسل.
- لتوليد SRT من صوتك: `whisper voice.mp3 --language Arabic --output_format srt` (OpenAI Whisper، بديل: أي أداة تنتج SRT).
- الصور تُؤخذ من `images/` إن وُجدت، وإلا تُنزَّل من الرابط الرسمي وتُخزَّن في `.cache/images`.
- أمثلة: `video-editor/examples/`.

## النشر

**GitHub:** ارفع المجلد كما هو. ملف CI يشغّل الفحص والاختبارات وفحص الروابط تلقائياً.

**استضافة سحابية (Render / Railway / Fly.io / Cloud Run):** استخدم `Dockerfile` الموجود. اضبط المتغيرات: `MCP_AUTH_TOKEN` (مهم) و`PORT` إن لزم. فحص الصحة: `GET /health`.
محرر الفيديو يعمل محلياً/على خادمك مع FFmpeg، وليس جزءاً من صورة Docker.

## إضافة بيانات

أضف عنصراً إلى `database/items.json` (نفس شكل المدخلات الحالية: `id` و`name.en` و`name.ar` و`aliases` و`category` و`image.path`)، ثم:
`npm run validate && npm run images:verify`

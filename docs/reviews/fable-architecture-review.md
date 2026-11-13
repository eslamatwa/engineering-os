# مراجعة معمارية Claude Engineering OS (v0.1 draft)

- **المراجع:** Fable (senior reviewer) — مراجعة تصميم فقط، لا يوجد تنفيذ.
- **التاريخ:** 2026-11-12
- **ما تمت قراءته:** `README.md`, `CLAUDE.md`, `config/agents.yaml`, `config/policies.yaml`, `config/routing.yaml`, `docs/architecture.md`, `docs/execution-contract.md`, `docs/security-and-governance.md`, `integrations/claude-code/README.md`, `integrations/claude-desktop/README.md`, `workspace/**`, `tests/acceptance-scenarios.md`, والمسودة الحالية `docs/engos-architecture.html`.
- **مصدر التحقق من المنصة:** وثائق Claude Code الرسمية (صفحات hooks، sub-agents، plugin manifest reference) كما قُرئت يوم المراجعة. كل ادعاء عن المنصة في هذا التقرير عليه واحدة من علامتين:
  - **[موثَّق]** = موجود نصاً في الوثائق التي قرأتها.
  - **[غير متحقق]** = لم أجده في الوثائق أو لم أختبره؛ لازم يتجرب قبل ما التصميم يعتمد عليه.
- لم يُشغَّل أي كود ولم يُختبر أي hook فعلياً. كل ما في التقرير تحليل تصميم.

---

## 1) أهم 5 تغييرات أوصي بها (مرتبة)

### 1. خلّي الـ gate يفشل مقفول (fail-closed)، وكن صريحاً في حدود الإنفاذ
المسودة بتكتب "Enforced: yes" قدام حاجات هي في الحقيقة "enforced لو الـ hook اشتغل، ولو الموديل ما استخدمش Bash". الوثائق صريحة: أي hook يخرج بكود غير 0 وغير 2 (مثلاً crash، أو `node` مش متثبت = exit 127، أو timeout) يعتبر **non-blocking** والـ tool call بيكمل **[موثَّق]**. يعني الـ policy gate بالشكل الحالي بيفشل مفتوح. الحل: `"onFailure": "block"` على hooks الـ gate (متاح من v2.1.295 **[موثَّق]**)، wrapper يحوّل أي خطأ داخلي لـ exit 2، self-test في `SessionStart`، وإعلان حد أدنى لنسخة Claude Code. ومعاه: إعادة تسمية عمود "Enforced" لثلاث درجات (prevented / detected / advisory) بدل yes/no. التفاصيل في A1 و A3.

### 2. صلّح قناة الـ approval: الإثبات الحالي أن "الإنسان هو اللي كتب" مش كافي
`UserPromptSubmit` بيشتغل كمان على: scheduled task، `/loop`، background subagent بيرجّع تقريره، ورسالة من session تانية — ومفيش field في الـ input بيفرّق بينهم وبين كتابة الإنسان **[موثَّق]**. ده عيب حقيقي في **آلية** القرار رقم 4 (مش في المبدأ). الحل المقترح: الـ gate هو اللي يكتب الـ request من الـ `tool_input` الفعلي (مش الموديل)، الـ ID مشتق من الـ hash، النص الحرفي للـ action يتعرض للمستخدم بكود (`systemMessage`)، الالتقاط يكون بـ `UserPromptExpansion` + مطابقة كاملة للسطر، ومنع تشغيل `claude` من Bash. التفاصيل في A2 و A5.

### 3. التصنيف يبقى "ratchet": الموديل يقترح، والكود يراقب ويرفع الحد الأدنى فقط
ما تعتمدش على intake الموديل كبوابة. الـ class الفعلي = أعلى قيمة بين (تصريح الموديل، إشارات نص الطلب، ما رصده الكود فعلاً). الموديل يقدر يرفع الـ class لكن عمره ما ينزّله تحت ما الكود شافه. والـ fast path يبقى **lazy**: مفيش أي ceremony لحد ما أول tool call فيه تعديل يحصل؛ ساعتها الـ gate يفتح task تلقائي من نوع `trivial_edit` ويراقب الميزانية (files / lines / paths / commands)، ولو اتخطت أو اتلمس protected path يوقف ويطلب الترقية. التصميم الكامل في القسم B.

### 4. الـ evidence يسجّله الكود مش الموديل، وتغيير الحالة يمر من CLI واحد
"Validator runs the checks" + "Stop hook يرفض complete بدون validation record" يسيبوا الموديل هو اللي يحكي النتيجة. الأفضل: أوامر الـ acceptance تتسجل نتيجتها من `PostToolUse` / `PostToolUseFailure` (الأخير بيدّي `Exit code N` **[موثَّق]**)، وكل انتقال حالة (`active → validating → complete`) يتم عن طريق `engos` CLI بيتحقق من الشروط، مش بتعديل YAML باليد. ومعاه قاعدة: الـ acceptance criteria ما تتغيرش بعد بدء التنفيذ إلا بـ amendment مسجّل. التفاصيل في A8 و A10 والقسم C.

### 5. قلّص v0.1 واحسب التكلفة والـ latency من الأول
ستة ملفات agents + validator "≥ tier of the worker" + default على opus + hook على كل tool call = منتج غالي وبطيء، وده أول سبب للـ uninstall. المقترح: الـ lead ينفّذ الـ trivial بنفسه بدون subagent، الـ validation الأساسي بالكود والموديل validator يُستدعى فقط عند الحاجة، tier الـ validator يتحدد من درجة الـ assurance مش من tier الـ worker، hooks بـ matcher ضيق و no-op سريع لو مفيش `.engos/`، وأمر `/engos:pause` مسجّل بدل ما المستخدم يشيل الـ plugin. وسدّ ثغرات إنفاذ الـ tier (A4). التفاصيل في A16–A19.

---

## 2) القسم A — مراجعة المعمارية

الترتيب: P0 = يكسر ضمانة معلنة، P1 = مش هيشتغل زي ما مكتوب أو فيه فجوة تصميم، P2 = friction / cost / latency.

### P0 — يكسر الضمانات

#### A1. الـ gate بيفشل مفتوح
- **الحقيقة [موثَّق]:** exit 2 = block. أي exit تاني غير الصفر (1، أو 127 لما الـ command مش موجود) = "non-blocking error… The action goes ahead". وكمان: "On PreToolUse, a timed-out hook doesn't block the tool call".
- **الأثر:** لو المستخدم معندوش runtime السكريبت، أو السكريبت وقع على YAML بايظ في `.engos/`، كل الحماية بتختفي في صمت تقريباً (سطر notice في الـ transcript فقط).
- **المطلوب:**
  1. `"onFailure": "block"` على كل hook له دور حماية (v2.1.295+ **[موثَّق]**) + إعلان الحد الأدنى للنسخة، والتحقق منه في `SessionStart`.
  2. كل entrypoint جوّه `try/catch` شامل: أي exception على tool فيه تعديل ⇒ exit 2 برسالة واضحة.
  3. استخدم **exec form** (`command` + `args`) بدل shell form عشان تتجنب مشاكل الـ quoting والمسافات في المسارات على Windows **[موثَّق أن exec form موجود]**.
  4. حالة config تالف: الـ gate يدخل "safe mode" = `read_only` + رسالة للمستخدم، مش يسيب كل حاجة.
- **ملاحظة Windows [موثَّق]:** من غير Git Bash، أي exit code غير 0 و 2 بيتحسب failure في `PreToolUse` و `PermissionRequest` — يعني السلوك مختلف بين المنصات؛ لازم يتغطى في الاختبارات.

#### A2. `UserPromptSubmit` مش إثبات إن إنسان كتب (عيب في آلية القرار 4)
- **الحقيقة [موثَّق]:** الـ hook "also fires on turns Claude Code starts on its own": scheduled task / `/loop` iteration، background subagent reporting back، ورسالة من session تانية. الـ input فيه `prompt` والحقول المشتركة فقط؛ مفيش حقل origin.
- **مسارات تزوير عملية:**
  - الموديل يشغّل `claude -p "/engos:approve APR-003"` من Bash ⇒ session جديدة في نفس الـ repo، والـ hook هيسجّل approval.
  - session تانية (أو agent فيها) تبعت رسالة نصها أمر الموافقة.
  - scheduled task نصها أمر الموافقة.
  - أبسط من كل ده: الموديل يكتب ملف `approvals/APR-003.yaml` مباشرة بـ Bash (شوف A3).
- **المطلوب (دفاع على طبقات):**
  1. الالتقاط الأساسي بـ `UserPromptExpansion` (بيدّي `expansion_type: slash_command`، `command_name`، `command_args` **[موثَّق]**، وموصوف أنه لمسار "user-typed command"). هل بيشتغل على رسالة جاية من session تانية أو scheduled task؟ **[غير متحقق]** — ده أول اختبار لازم يتعمل.
  2. مطابقة **السطر كله** (`^/engos:approve APR-[0-9a-f]{8}$`)، مش substring؛ عشان لصق log فيه النص ما يعتبرش موافقة.
  3. الـ gate يمنع دائماً من Bash: تشغيل `claude` CLI، وأي لمس لمخزن الـ approvals/ledger (فئة `self_protect` في القسم B).
  4. الـ hook يرفض الموافقة لو الـ process وارث `CLAUDECODE` من session أب (كشف nested session) — وجود المتغير ده بالاسم ده **[غير متحقق]**.
  5. للـ actions الأعلى خطورة: كود تأكيد قصير يتعرض للمستخدم فقط عن طريق `systemMessage` ("shown to the user", Claude لا يراه **[موثَّق]**) ويتكتب مع الأمر. تحذير: هل الـ `systemMessage` بيتكتب في ملف الـ transcript اللي الموديل يقدر يقراه بـ Bash؟ **[غير متحقق]**.
  6. بديل يستحق الدراسة: `permissionDecision: "ask"` من `PreToolUse` بيطلّع native permission prompt للمستخدم **[موثَّق]**. ده فعل لا يقدر الموديل ينفّذه، و friction أقل من كتابة أمر. عيوبه: مفيش record جاهز (لازم يتبني من `PostToolUse`)، وسلوكه في `bypassPermissions` / `auto` / headless **[غير متحقق]**. ممكن يستخدم كدرجة تأكيد أخف من الـ typed approval، مش بديل له.
- **الخلاصة الصريحة:** من غير عزل على مستوى الـ OS، الموافقات **tamper-evident** مش **tamper-proof**. ده لازم يتكتب في الـ README بنفس الوضوح.

#### A3. Bash بيلفّ حوالين كل حاجة، والـ plugin ما يقدرش يشحن permissions أو sandbox
- المسودة معترفة جزئياً ("Limits of in-process enforcement"). لكن الجدول في القسم 4 لسه بيقول "yes" لـ execution modes و evidence و ledger.
- **الحقيقة [موثَّق]:**
  - الوثائق نفسها بتقول عن فلتر `if` إنه best-effort و "use the permission system rather than a hook to enforce a hard allow or deny".
  - `settings` بتاعة الـ plugin: "Only `agent` and `subagentStatusLine` take effect" — يعني الـ plugin **ما يقدرش** يشحن `permissions.deny` ولا إعدادات sandbox.
- **الأثر:** "writes to `.engos/approvals/` and `ledger.jsonl` from the model: always blocked" صحيحة لـ `Edit`/`Write` فقط. `echo ... > .engos/approvals/APR-003.yaml` أو `python -c` أو `sed -i` بيعدّوا إلا لو الـ pattern اتمسك.
- **المطلوب:**
  1. انقل الجزء اللي عليه الثقة (approvals + ledger) برّه الـ repo إلى `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`، دائم عبر التحديثات **[موثَّق]**) تحت مفتاح الـ repo. ده مش بيمنع Bash، لكن بيشيل الملفات من مسار الشغل الطبيعي وبيخلّي أي لمس ليها واضح أنه مقصود. (انحراف جزئي عن القرار 2 — شوف القسم 5.) تنبيه: المجلد بيتمسح عند uninstall إلا مع `--keep-data` **[موثَّق]**؛ لازم export للـ audit.
  2. `/engos:init` يعرض (بموافقة المستخدم) إضافة `permissions.deny` وإعداد sandbox في `.claude/settings.json` بتاع المشروع. توفر الـ sandbox على Windows **[غير متحقق]**.
  3. ledger بـ hash chain (`prev_hash`) عشان التلاعب يبقى مكشوف.
  4. تصنيف Bash بـ default-deny للفئات الخطرة + **رصد بعد التنفيذ** (`git status` / `git diff --numstat` بعد كل Bash غير read) — ده أساس القسم B.
  5. الجدول يتحول لثلاث درجات:

| الدرجة | المعنى | أمثلة |
| --- | --- | --- |
| prevented | الكود يمنع قبل التنفيذ والمسار معروف يقيناً | `Edit`/`Write` على protected path، `Agent` بـ tier غلط |
| detected | الكود يكتشف بعد التنفيذ ويوقف الـ task | تعديل غير مباشر بـ Bash، تخطّي الميزانية |
| advisory | نص في skill / role card | جودة الخطة، سلوك الـ role |

#### A4. إنفاذ الـ tier فيه ثغرات
كل النقاط التالية **[موثَّق]** إلا ما ذُكر:
- الـ tool اسمه `Agent` من v2.1.63 (`Task` alias). الـ matcher لازم يكون `Agent|Task`.
- `Agent` بيقبل `model` لكل استدعاء، وده **بيغلب** الـ frontmatter. يعني `worker-haiku` ممكن يتشغّل على opus بـ parameter. الـ hook لازم يفحص `tool_input.model` كمان مش `subagent_type` فقط.
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` بيخلّي env var يغلب كل المصادر. الـ plugin مش هيعرف. الـ ledger لازم يسجّل الموديل **الفعلي** — مصدره من hook input **[غير متحقق]**؛ احتمال يتقرا من transcript الـ subagent وصيغته غير مضمونة.
- الـ subagents بتقدر تعمل spawn لـ subagents لحد 3 مستويات بالـ default. لازم `Agent` يتشال من `tools` بتاعة الـ workers والـ validators، وإلا worker يفوّض لـ `general-purpose` خارج النظام.
- الـ built-in agents (`general-purpose`, `Explore`, `Plan`, `claude`) برّه نظام الـ tiers. و `Explore` بيشتغل على Opus في الاشتراكات. الـ gate لازم يقرر: أثناء task نشط، يسمح بإيه منهم؟ (اقتراح: `Explore` و `Plan` مسموحين لأنهم read-only؛ الباقي deny.)
- `fable` alias موجود في قيم `model`، لكن توفره يعتمد على خطة المستخدم والـ provider (Bedrock/Vertex). لازم `tiers` تبقى mapping قابل للتعديل في `.engos/config.yaml` مع fallback معلن (مثلاً `deep → opus` لو مش متاح).
- الـ `effort`: مدعوم في frontmatter الـ subagent (`low…max`) — ده بيجاوب بند "Effort per step" المفتوح: **لكل تعريف، مش لكل استدعاء** (مفيش `effort` في `tool_input` بتاع `Agent` حسب ما قرأت).
- الـ main session: الـ plugin ما يقدرش يثبّت موديلها؛ المستخدم بيغيّره. "The main session stays on one model" توصية مش ضمانة. (فيه `PreModelSwitch` event ممكن يحذّر.)

#### A5. المستخدم مش شايف هو بيوافق على إيه
- في المسودة: الموديل يكتب `requests/APR-003.yaml` "with the exact action"، والـ gate "tells the user which ID to approve".
- **المشاكل:**
  - `permissionDecisionReason` بتاع الـ deny بيروح لـ Claude، مش للمستخدم. اللي المستخدم هيقراه هو **إعادة صياغة الموديل**.
  - الموديل ممكن يكتب في الـ request نص غير اللي هينفّذه؛ الـ hash هيفشل عند التنفيذ (كويس) لكن المستخدم اتطلب منه يوافق على حاجة تانية.
  - `git push origin release/1.2` ما بيربطش **إيه** اللي هيتبعت: الموديل ممكن يضيف commits بعد الموافقة.
- **المطلوب:**
  1. الـ gate نفسه ينشئ الـ request لحظة المنع، من الـ `tool_input` الحقيقي. الموديل ما يكتبش requests.
  2. `approval_id` مشتق من الـ hash (`APR-9f2c41d7`) عشان ما ينفعش تبديل المحتوى تحت نفس الـ ID.
  3. النص الحرفي يتعرض بـ `systemMessage`، و `/engos:approve` من غير arguments يعرض المعلّق (بـ `decision: block` والـ `reason` "shown to the user, not added to context" **[موثَّق]**).
  4. الـ hash يربط السياق: `tool_name` + normalized input + `cwd` + `task_id` + للـ git: `HEAD` sha والـ branch + لسكريبت محلي: sha256 لمحتوى الملف وقت الطلب (ضد TOCTOU).

### P1 — مش هيشتغل زي ما مكتوب / فجوات تصميم

#### A6. مفهوم "الـ task النشط" غير معرّف
- الـ gate "reads the active task's mode"، وصف `question` بيقول "Task record: none, Gate: read_only". النتيجة الحرفية: أي تعديل من غير task ممنوع ⇒ كل تعديل صغير محتاج ceremony ⇒ عكس هدف الـ fast path.
- ناقص كمان:
  - ربط الـ task بـ `session_id` (موجود في كل hook input **[موثَّق]**). جلستين على نفس الـ repo أو git worktrees = مين الـ task النشط؟
  - الـ compaction: حالة الـ orchestration في context الـ lead بتضيع. لازم `SessionStart` بـ source `compact`/`resume` **[موثَّق]** يعيد حقن ملخص الـ task من الملفات. حد الـ output 10,000 حرف **[موثَّق]**.
  - المستخدم يغيّر الموضوع في نص الـ task: مين يقفل القديم؟
- الحل في القسم B (auto-open + state machine).

#### A7. الـ subagents بتبدأ في الخلفية بالـ default
- **[موثَّق]:** "Subagents spawned from the main conversation start in the background by default"؛ الـ background subagents عندها مجموعة tools أصغر؛ ورجوع تقريرها بيشغّل `UserPromptSubmit`.
- **الأثر:** الـ loop "Route → Execute → Verify → Escalate" مش synchronous. الـ lead ممكن يكمّل أو يحاول ينهي والـ worker لسه شغال؛ `Stop` hook لازم يعرف إن فيه steps مفتوحة؛ ونسبة التعديلات لـ worker معين محتاجة `agent_id` (موجود في input الـ tool hooks **[موثَّق]**).
- **المطلوب:** قاعدة ثابتة في v0.1: **writer واحد في المرة**؛ التوازي للـ read-only فقط. وحالة كل step في ملف، مش في ذاكرة الـ lead. طريقة إجبار foreground من plugin **[غير متحقق]** (الوثائق ذكرت `CLAUDE_CODE_FORK_SUBAGENT=0` كـ env للمستخدم).

#### A8. "Validator read-only" و "runs the checks" متناقضين، والـ evidence محكي مش مرصود
- تشغيل tests يحتاج Bash، و Bash يكتب (caches, snapshots, coverage). يبقى الـ validator مش read-only فعلاً.
- الـ acceptance criteria بيكتبها الموديل، فممكن يكتب check ضعيف (`echo ok`).
- **المطلوب:**
  1. فصل: **الكود يشغّل/يسجّل الـ checks**، والـ validator **يحكم** على الـ scope والكفاية. تسجيل النتيجة: `PostToolUse` معناه نجاح الأمر، و `PostToolUseFailure` بيدّي `Exit code N` في أول سطر من `error` **[موثَّق]** (مفيش exit code في `tool_response` بتاع Bash **[موثَّق]**).
  2. أمر الـ test/lint/build الرسمي يتعرّف مرة في `.engos/config.yaml` بيد الإنسان في `/engos:init`. الـ rule table تفرض حد أدنى من الـ evidence لكل class (القسم B) بحيث الموديل ما يقدرش ينزل تحته.
  3. الـ validator: بدون `Edit`/`Write`، و Bash مسموح فقط لأوامر الـ checks المعرّفة + فئة read.

#### A9. توصيل الـ role cards والـ skills للـ subagents
- **[موثَّق]:** الـ subagent ما يورثش الـ skills اللي اتنادت ولا الـ history؛ بياخد system prompt بتاعه + رسالة التفويض + `CLAUDE.md` + skills مذكورة في `skills:` (بتتحمّل كاملة). و `CLAUDE_PLUGIN_ROOT` **مش موجود** في environment أوامر Bash؛ بيتعوّض inline في نص الـ skill/agent فقط.
- **الأثر:** "role = card added to the brief" محتاج آلية. لو الـ lead بينسخ الكارت في الـ prompt، ده tokens من context الـ lead في كل step.
- **المطلوب:** `SubagentStart` hook يحقن الكارت + عقد الـ step بـ `additionalContext` ("at the start of the conversation, before the first prompt" **[موثَّق]**). كده اختيار الـ role بقى كود. الحد 10,000 حرف، فالكروت لازم تبقى قصيرة.
- **تنبيه:** `CLAUDE.md` في جذر الـ plugin **لا يتحمّل** كـ context، و `claude plugin validate` بيحذّر منه **[موثَّق]**. محتوى `CLAUDE.md` الحالي لازم يتنقل لـ skill أو لحقن `SessionStart`.

#### A10. الموديل بيعدّل ملفات الحالة مباشرة، و `Stop` hook مكان غلط للإنفاذ
- YAML بـ schema أحسن من Markdown tables، لكن لو الموديل بيكتبه بـ `Edit` هيحصل drift برضه.
- `Stop` hook "refuses to end a task marked complete": مين اللي علّمه complete؟ وكمان `Stop` ما بيشتغلش لما المستخدم يقاطع، وفيه خطر loop (وجود `stop_hook_active` لمنعه **[غير متحقق في قراءتي]**).
- **المطلوب:** CLI واحد `engos` (ملف في `bin/` بيتحط على PATH بتاع Bash tool **[موثَّق]**) هو الوحيد اللي بيغيّر الحالة، ويرفض الانتقال لو الشروط ناقصة. الـ gate يمنع `Edit`/`Write` على ملفات الحالة. `Stop` hook يبقى تذكير فقط ("فيه task مفتوح حالته كذا").
- **تنبيه [موثَّق]:** وجود `bin/` بيمنع تثبيت الـ plugin على claude.ai و Cowork. مقبول لو المنتج Claude Code فقط — قرار للمالك.

#### A11. قواعد الـ escalation غامضة ومتعارضة مع مستند تاني
- "retry same tier → tier up → blocked after 3 cycles": مهمة بدأت على sonnet تمشي sonnet, sonnet, opus ثم blocked — عمرها ما توصل fable. هل الـ 3 لكل tier ولا للمهمة؟
- مش كل فشل سببه قدرة الموديل: dependency ناقصة، test flaky، criterion غلط، scope ضيق. الترقية هنا فلوس مرمية.
- `config/routing.yaml` الأصلي بيصعّد على `confidence_below_threshold` و `conflicting_evidence`، و `tests/acceptance-scenarios.md` رقم 3 بيقول "uncertain or cross-system findings escalate". ده **متعارض** مع القرار 5 (failed checks فقط). معالجة مقترحة في B (تحويل "uncertain" لـ check قابل للفشل).
- **المطلوب:** تصنيف للفشل:

| نوع الفشل | الإجراء |
| --- | --- |
| `check_failed` | retry نفس الـ tier مع الـ output الحرفي، ثم tier up |
| `env_error` | لا يُحسب cycle؛ يرجع للـ lead، ثم للإنسان |
| `scope_violation` | reclassification (القسم B) |
| `criterion_disputed` | مسار النزاع (القسم C) |

#### A12. الـ ledger مش هيعرف tokens ولا تكلفة
- الحقول المشتركة في hook input مفيهاش usage ولا cost **[موثَّق للحقول المشتركة]**. المتاح: `duration_ms` في `PostToolUse`، عدد الـ tool calls، `agent_type`. المسودة الأصلية قالت "does not invent costs" وده صح؛ بس الـ README ما يوعدش بتقرير تكلفة.

#### A13. `.engos/` والـ git والمسارات
- إيه اللي يتعمله commit؟ `ledger.jsonl` و `tasks/` في git = merge conflicts وضوضاء في كل PR. اقتراح: `config.yaml` و `BRIEF.md` و `STATE.yaml` committed؛ `tasks/` محلية (gitignored) بالـ default مع خيار.
- Windows: مسارات case-insensitive و backslashes؛ مطابقة protected paths لازم تتم بعد normalization و resolve للـ symlinks. الوثائق بتقول إن مسارات `PreToolUse` بتتحول absolute **[موثَّق]** — ده يساعد لكن مش كفاية للـ case.
- worktrees (`isolation: worktree`): `.engos/` المحلي هيبقى في مجلد تاني؛ حدد الجذر بـ `git rev-parse --git-common-dir`.
- repo مش git: الرصد بعد التنفيذ بيضعف. لازم "degraded mode" معلن.

#### A14. المستندات الأصلية لسه بتناقض القرارات
قبل البناء لازم مصدر حقيقة واحد. تناقضات موجودة حالياً:

| الملف | النص | يتعارض مع |
| --- | --- | --- |
| `README.md`, `docs/architecture.md` | "adapters enable future multi-provider support" | القرار 1 |
| `integrations/claude-desktop/README.md` | MCP surface لـ Desktop | نطاق plugin فقط |
| `CLAUDE.md` | "Load `workspace/PROJECT_BRIEF.md`" | `.engos/` (القرار 2) |
| `config/routing.yaml` | tiers: `fast/balanced/frontier`؛ escalation على confidence | 4 tiers؛ القرار 5 |
| `config/agents.yaml` | roles لها `model_tier` ثابت + `classifier` و `chief_orchestrator` كـ agents | roles = prompt cards |
| `docs/execution-contract.md` | `classification: feature\|bugfix\|…` | 4 classes في fast path |
| `config/policies.yaml` | `security_sensitive_change: explicit_human_approval` | المسودة ما بتذكرش approval للتعديل الحساس، بس للـ delivery |

آخر صف مهم: القسم B بيقترح "scope approval" عشان يغطيه.

### P2 — friction / cost / latency (أسباب الـ uninstall)

#### A15. latency الـ hooks
- كل hook = process جديد على كل tool call مطابق. Node cold start عشرات الـ ms، Python على Windows أكتر.
- **المطلوب:** matcher ضيق (`Edit|Write|NotebookEdit|Bash|Agent|Task|mcp__.*`)؛ `Read/Grep/Glob` برّه إلا لو فيه سياسة لقراءة secrets. أول سطر في السكريبت: لو مفيش `.engos/` ⇒ exit 0 فوراً — لأن plugin متثبت على user scope بيشتغل في **كل** repo. ميزانية معلنة: p95 أقل من 50ms للـ gate، وتتقاس في CI.

#### A16. تكلفة الـ subagents والـ validators
- كل spawn = context بارد (system prompt + `CLAUDE.md` + إعادة قراءة الملفات). الـ cache بتاع الـ main session محفوظ فعلاً، لكن ده مش معناه إن الـ subagents رخيصة.
- "validator ≥ tier of the worker" + "high_risk: validator one tier up" ⇒ worker opus ⇒ validator fable. ده بيضاعف تكلفة أغلى المهام.
- **المطلوب:** validation بالكود أولاً. الموديل validator فقط لما: مفيش check تنفيذي، أو الـ assurance عالي. tier الـ validator من الـ assurance (القسم B). وميزانية اختيارية لكل task (`max_subagent_spawns`) لما تتخطى ⇒ يرجع للإنسان.

#### A17. friction الموافقات ومفيش مخرج
- كتابة `/engos:approve APR-9f2c41d7` لكل push مقبولة لو نادرة. لازم: `/engos:approve` بدون ID لما يكون فيه طلب واحد معلّق (مع عرض النص)، و `/engos:reject`.
- لازم `/engos:pause` و `/engos:resume` (يتكتبوا بيد المستخدم ويتسجلوا). من غيرهم البديل الوحيد هو الـ uninstall.
- headless / CI (`claude -p`): مفيش إنسان ⇒ كل ما يحتاج approval يتمنع. يتوثق صراحة.

#### A18. over-engineering في v0.1
- 6 skills + 6 agents + ledger + approvals + router + validator loop كله في أول إصدار.
- **تبسيط اختياري للـ agents:** بما إن `model` لكل استدعاء بيغلب الـ frontmatter، والإنفاذ الحقيقي في الـ hook، ممكن 3 ملفات بس: `scout` (read-only)، `worker`، `validator` — والـ tier يتحدد بـ `model` parameter والـ hook يتحقق. ده بيقلل الملفات لكنه بيخلّي الـ hook نقطة الإنفاذ الوحيدة (مقبول فقط بعد A1)، وبيفقد `effort` لكل tier. ده **تعديل على شكل** القرار 5 مش على مبدأه — قرار للمالك.
- ترتيب بناء مقترح: (1) gate + رصد + fast path، (2) approvals، (3) evidence بالكود، (4) workers و escalation، (5) model validator.

#### A19. ثقة المستخدم العام في plugin بيشغّل كود على كل tool call
- سكريبتات صغيرة، بدون network، بدون dependencies، مقروءة. `claude plugin validate --strict` في CI.
- **الاسم [موثَّق]:** اسم plugin يبدأ بـ `claude-` = error في الـ validator؛ و `claude` ككلمة كاملة في أي مكان تاني = warning ("reads as one of Anthropic's own"). `engos` كـ `name` سليم. "Claude Engineering OS" كـ `displayName` محتاج مراجعة قبل النشر.

#### A20. لغة سكريبتات الـ hooks
- Claude Code بيتثبت دلوقتي كـ native binary، فوجود Node مش مضمون **[غير متحقق كنسبة انتشار]**.
- توصيتي: Node ملف واحد بدون dependencies في v0.1، مع عقد ثابت (JSON على stdin ⇒ JSON على stdout) عشان إعادة الكتابة بـ Go binary لاحقاً تبقى drop-in. ومع `onFailure: block`، غياب Node = منع واضح مش تجاوز صامت.

---

## 3) القسم B — إزاي النظام يقرر المهمة محتاجة إيه (needs assessment)

### B.1 المبادئ

1. **الموديل يقترح، الكود يضع الأرضية.** الـ intake مدخل غير موثوق. يقدر يرفع، وما يقدرش ينزّل تحت ما الكود رصده.
2. **monotonic داخل الـ task.** الـ class بيطلع بس. النزول بأمر مكتوب من الإنسان فقط، وبعض الأرضيات ما تنزلش خالص في v0.1.
3. **lazy.** مفيش ceremony قبل ما يبقى فيه سبب مرصود.
4. **محورين مش محور واحد.** `change_risk` (خطر الفعل ⇒ الـ gate والـ approvals) و `assurance` (تكلفة الاستنتاج الغلط ⇒ الـ evidence والـ validator). security audit مثلاً: `change_risk` صفر و `assurance` عالي. الـ class الواحد بيخلط الاتنين.
5. **المنع حيث المسار معروف، والرصد حيث مش معروف.** `Edit`/`Write` مسارهم في `tool_input` ⇒ prevented. Bash ⇒ تصنيف قبل + رصد بعد ⇒ detected.

### B.2 مصادر الإشارات

| المصدر | مين يكتبه | الثقة | الاتجاه |
| --- | --- | --- | --- |
| `declared` | الـ lead (intake skill) | غير موثوق | يرفع فقط |
| `lexical` | كود، على نص الطلب في `UserPromptSubmit` | ضعيف | يرفع فقط |
| `planned` | الـ lead (الخطة: `scope.paths`) ثم فحص كود ضد protected paths | متوسط | يرفع فقط |
| `observed` | hooks فقط | عالي | يضع الأرضية |
| `human` | أمر مكتوب | نهائي | يرفع أو ينزّل (ما عدا hard floors) |

`effective.class = max(declared, lexical, planned, observed)` على الترتيب `question < trivial_edit < standard < high_risk`، ثم يتطبق override الإنسان إن وُجد.

**إشارات الرصد (كلها كود):**
- من `PreToolUse` على `Edit|Write|NotebookEdit`: المسار المطلوب (قبل التنفيذ).
- من `PreToolUse` على `Bash`: فئة الأمر (جدول B.4).
- من `PreToolUse` على `mcp__*`: tool خارجي ⇒ فئة `external` إلا لو في allowlist.
- من `PostToolUse` بعد أي Bash غير `read`: `git status --porcelain` + `git diff --numstat` مقارنة بـ snapshot بداية الـ task ⇒ ملفات اتغيرت فعلاً، سطور، حذف، ملفات جديدة. (حقل `bashEditDiff.changedFiles` مذكور في الوثائق "when recording is on" — مصدر محتمل، شروطه **[غير متحقق]**.)
- حالة الـ repo: وجود tests، وجود أمر test معرّف في config، هل الـ repo git.
- تاريخ الـ task: `failed_cycles`, `out_of_scope_attempts`.

### B.3 دورة الحياة (state machine)

```text
idle ──(mutating tool call, passes trivial predicates)──▶ auto task: trivial_edit
idle ──(/engos:task أو الـ lead يشغّل intake)──▶ profiled ──▶ planned ──▶ active
trivial_edit ──(budget exceeded | floor hit)──▶ upgrade_pending ──(profile+plan)──▶ active
active ──(floor hit: high_risk)──▶ upgrade_pending ──(scope approval)──▶ active
active ──(violation detected post-hoc)──▶ needs_human
active ──▶ validating ──(evidence ok)──▶ complete
validating ──(fail ×3 | dispute)──▶ needs_human | blocked
```

- `idle`: مفيش task. القراءة حرة. ده هو class `question` — **من غير أي record ومن غير أي استدعاء للموديل للتصنيف**.
- أول mutating call في `idle`: الـ gate يقيّم predicates الـ trivial على الـ call ده. نجحت ⇒ يفتح `TASK-auto` ويسمح فوراً ويكتب سطر ledger. فشلت ⇒ deny مع سبب محدد ("المسار protected ⇒ مطلوب profile + plan").
- `upgrade_pending`: كل mutating call ممنوع لحد ما المطلوب يتوفر. القراءة مسموحة.

### B.4 تصنيف أوامر Bash

| الفئة | أمثلة | `idle` / trivial | standard | high_risk |
| --- | --- | --- | --- | --- |
| `read` | `ls`, `cat`, `rg`, `git status/log/diff` | allow | allow | allow |
| `check` | الأوامر المعرّفة في `config.checks` | allow + record | allow + record | allow + record |
| `vcs_local` | `git add/commit/switch/branch/stash` | allow | allow | allow |
| `pkg_install` | `npm i`, `pip install`, `cargo add` | upgrade ⇒ standard | allow + observe | allow + observe |
| `unknown` | `python x.py`, `npm run foo`, pipes | allow + observe | allow + observe | allow + observe |
| `network` | `curl`, `wget`, `ssh`, `scp` | upgrade ⇒ high_risk | approval | approval |
| `vcs_remote` | `git push`, `gh pr create`, `npm publish` | approval | approval | approval |
| `destructive` | `rm -rf` خارج temp, `git reset --hard`, `git clean`, `DROP` | approval | approval | approval |
| `self_protect` | أي لمس لمخزن approvals/ledger, `claude` CLI, تعديل hooks/settings | deny دائماً | deny دائماً | deny دائماً |

ملاحظات صريحة:
- `unknown = allow + observe` اختيار مقصود: منع كل أمر غير معروف هيخلّي الـ plugin غير قابل للاستخدام. التمن: تعديل غير مباشر بيتكشف **بعد** ما يحصل. داخل الـ repo ده مقبول (git بيرجّع). برّه الـ repo مش مرصود — ده حد الـ in-process enforcement ولازم sandbox.
- التصنيف بيتم على كل subcommand بعد تفكيك `&&`, `;`, `|`, `$()`. أي جزء فشل تفكيكه ⇒ يُعامل كأعلى فئة ظهرت أو `unknown`.

### B.5 Schema: task profile

```yaml
# .engos/tasks/TASK-012.profile.yaml  — يكتبه engos CLI فقط
schema: engos/task-profile@1
task_id: TASK-012
session_id: "c41f…"
opened_at: 2026-11-12T10:00:00Z
opened_by: auto            # auto | lead | human
base:
  git: true
  head: "a1b2c3d"
  dirty_at_open: ["README.md"]     # ملفات كانت متعدلة قبل الـ task؛ ما تتحسبش عليه

request:
  text_sha256: "sha256:…"
  summary: "Fix session timeout not refreshing on activity"

declared:                  # من الموديل. غير موثوق. يرفع فقط.
  kind: bugfix             # question|analysis|docs|trivial_edit|tests|bugfix|feature|refactor|
                           # debugging|security_review|architecture|migration
  mutates: true
  expected_paths: ["src/session/**"]
  expected_files: 2
  change_risk: low         # low|medium|high
  reversibility: easy      # easy|hard|irreversible
  external_effects: []     # push|publish|network|db|none
  unknowns: ["root cause not located yet"]   # قائمة، مش درجة ثقة
  rationale: "single module, tests exist"

lexical:                   # كود، من نص الطلب
  hits:
    - {term: "session", rule: L-auth-terms, floor: standard}

planned:                   # من الخطة، بعد فحص الكود
  scope:
    write: ["src/session/**", "tests/session/**"]
    read:  ["src/**"]
  protected_overlap: []    # تقاطع scope.write مع protected_paths (كود)

observed:                  # hooks فقط
  files_touched: ["src/session/refresh.ts"]
  files_count: 1
  files_created: 0
  files_deleted: 0
  lines_added: 9
  lines_deleted: 3
  modules: ["src/session"]
  protected_hits: []       # [{path, rule, via: edit|bash, prevented: true|false}]
  manifest_changed: false
  commands: {read: 14, check: 2, vcs_local: 0, unknown: 1}
  tests_present: true
  check_commands_known: true
  out_of_scope_attempts: 0
  failed_cycles: 0
  violations: []

effective:                 # ناتج الـ router. لا يُعدَّل باليد.
  class: standard
  change_risk: medium
  assurance: normal        # light|normal|high
  floor_sources: [L-auth-terms]
  mode: workspace_write
  roles: [implementer, validator]
  steps:
    - {id: S1, kind: locate,    role: triager,     tier: haiku,  owner: worker}
    - {id: S2, kind: implement, role: implementer, tier: sonnet, owner: worker}
    - {id: S3, kind: verify,    role: validator,   tier: sonnet, owner: validator}
  evidence_required: [E-scope, E-checks, E-residual-risk]
  approvals_required: []   # تتملى لما action يحتاجها
  human_override: null     # {class, by: human, at, command}

history:
  - {at: "10:00:02Z", from: null, to: trivial_edit, trigger: auto_open}
  - {at: "10:00:02Z", from: trivial_edit, to: standard, trigger: L-auth-terms}
```

ملاحظة على `unknowns`: بدل ما نسأل الموديل "واثق قد إيه؟" (رقم مالوش معنى)، بنطلب قائمة بالمجهولات. قائمة غير فاضية ⇒ الـ router يضيف step استكشاف read-only قبل التنفيذ ويعيد الحساب بعدها. ده بيحافظ على مبدأ "الـ router ما يسألش الموديل الصعوبة قد إيه".

### B.6 Schema: rule table

```yaml
# defaults/rules.yaml — يتدمج مع .engos/config.yaml (المشروع يقدر يشدّد، ما يقدرش يرخّي الـ hard floors)
schema: engos/rules@1
lattice: [question, trivial_edit, standard, high_risk]

protected_paths:                     # بعد normalization؛ case-insensitive على Windows/macOS
  high_risk:
    - "**/auth/**"
    - "**/security/**"
    - "**/*secret*"
    - "**/.env*"
    - "**/migrations/**"
    - ".github/workflows/**"
    - "**/Dockerfile*"
    - "**/terraform/**"
    - "**/k8s/**"
  standard:
    - "package.json"
    - "**/requirements*.txt"
    - "**/*.lock"
  never:                             # deny دائماً
    - ".engos/approvals/**"
    - ".engos/ledger*"
    - ".claude/settings*.json"
    - "**/hooks/hooks.json"

budgets:
  trivial_edit:
    max_files: 2
    max_changed_lines: 40
    max_created_files: 1
    max_deleted_files: 0
    bash_allowed: [read, check, vcs_local]
  standard:
    max_files: 25
    max_changed_lines: 800
    max_deleted_files: 5
    on_exceed: replan                # replan | high_risk

lexical_rules:                       # على نص الطلب؛ ترفع فقط
  - {id: L-auth-terms,  any: [auth, login, password, token, session, permission], floor: standard}
  - {id: L-data-terms,  any: [migration, schema, "drop table", backfill],        floor: high_risk}
  - {id: L-ship-terms,  any: [deploy, release, publish, production, prod],       floor: high_risk}
  - {id: L-destroy,     any: [delete all, wipe, purge, "force push"],            floor: high_risk}

floors:                              # كل القواعد المطابقة تتطبق؛ الناتج = أعلى class
  - id: F-idle-read
    when: {observed.files_count: 0, declared.mutates: false}
    class: question
  - id: F-trivial
    when: {within_budget: trivial_edit}
    class: trivial_edit
  - id: F-over-trivial
    when: {exceeds_budget: trivial_edit}
    class: standard
  - id: F-manifest
    when: {observed.manifest_changed: true}
    class: standard
  - id: F-multi-module
    when: {observed.modules: {min_count: 3}}
    class: standard
  - id: F-no-tests
    when: {observed.tests_present: false, observed.files_count: {min: 1}}
    assurance: normal                # مفيش tests ⇒ لازم validator موديل
  - id: F-protected
    when: {any: [observed.protected_hits, planned.protected_overlap], level: high_risk}
    class: high_risk
  - id: F-irreversible
    when: {declared.reversibility: [hard, irreversible]}
    class: high_risk
  - id: F-external
    when: {command_class: [network, vcs_remote, destructive]}
    class: high_risk                 # للـ action نفسه: approval؛ الـ task ما يتغيرش class لو push عادي (شوف hard_gates)
    scope: action
  - id: F-kind-assurance
    when: {declared.kind: [security_review, architecture, migration]}
    assurance: high

hard_gates:                          # لا ينزّلها إنسان ولا config في v0.1
  - {id: G-delivery,  when: {command_class: [vcs_remote, network, destructive]}, require: approval_per_action}
  - {id: G-protected, when: {write_path_level: high_risk},                      require: scope_approval}
  - {id: G-self,      when: {command_class: self_protect},                      require: deny}
  - {id: G-prod,      when: {lexical: L-ship-terms, action: deploy},            require: deny}   # v0.1

class_requirements:
  question:
    record: none
    plan: none
    mode: read_only
    validation: none
  trivial_edit:
    record: ledger_line
    plan: none
    mode: workspace_write
    owner: lead
    validation: {by: code, evidence: [E-diff-shown, E-checks-if-present]}
  standard:
    record: full
    plan: required
    mode: workspace_write
    owner: lead
    executor: worker
    validation: {by: code_then_model, evidence: [E-scope, E-checks, E-residual-risk]}
  high_risk:
    record: full
    plan: required
    mode: workspace_write
    owner: lead
    executor: worker
    validation: {by: code_then_model, evidence: [E-scope, E-checks, E-residual-risk, E-review-record]}
    human: [scope_approval_before_protected_write, close_acknowledgement]

tiers:                               # mapping قابل للتعديل؛ fallback لو tier مش متاح
  map: {fast: haiku, balanced: sonnet, frontier: opus, deep: fable}
  fallback: {deep: frontier}

step_tier_rules:                     # أول قاعدة مطابقة
  - {step: [search, extract, read_logs, summarize, locate], tier: fast}
  - {step: [docs, tests, implement], class: [trivial_edit, standard], kind: [docs, tests, bugfix], tier: balanced}
  - {step: implement, kind: [feature, refactor, debugging], tier: frontier}
  - {step: implement, class: high_risk, tier: frontier}
  - {step: [review_security], tier: frontier}
  - {step: [design, plan_migration], tier: deep}
  - {default: frontier}

validator_tier_rules:                # من الـ assurance، مش من tier الـ worker
  - {assurance: light,  by: code_only}
  - {assurance: normal, tier: balanced}
  - {assurance: high,   tier: frontier}
  - {assurance: high, class: high_risk, tier: deep, optional: true}   # يتفعّل من config

role_rules:                          # الحد الأدنى؛ الـ lead يقدر يضيف، ما يقدرش يشيل
  bugfix:          [implementer, validator]
  feature:         [implementer, validator]
  debugging:       [triager, implementer, validator]
  architecture:    [architect, critic]
  security_review: [security_reviewer, evidence_validator]
  analysis:        [analyst]
  add_when:
    - {when: {class: high_risk, protected: "**/auth/**"}, role: security_reviewer}

escalation:
  per_step_max_cycles: 3
  order: [retry_with_failure, tier_up]
  counts_as_cycle: [check_failed]
  not_a_cycle: [env_error, scope_violation, criterion_disputed]
  on_exhausted: blocked

evidence_kinds:
  E-diff-shown:      {by: code,  desc: "diff summary printed to user"}
  E-checks:          {by: code,  desc: "configured check commands ran; exit status recorded by hook"}
  E-checks-if-present: {by: code}
  E-scope:           {by: code,  desc: "observed files ⊆ planned.scope.write"}
  E-residual-risk:   {by: model, desc: "written, even if empty"}
  E-review-record:   {by: model, desc: "validator verdict with cited refs; refs verified by code"}
```

### B.7 إعادة التصنيف في نص المهمة

1. كل hook حدث (`PreToolUse`, `PostToolUse`) بيحدّث `observed` ويعيد حساب `effective`.
2. **قبل التنفيذ (prevented):** `Edit` على `src/auth/x.ts` والـ class أقل من `high_risk` ⇒ deny. السبب للموديل: القاعدة اللي اتطبقت + المطلوب بالظبط (profile، plan، scope approval). الـ task ⇒ `upgrade_pending`.
3. **بعد التنفيذ (detected):** Bash من فئة `unknown` عدّل ملف protected ⇒ `observed.violations` + الـ task ⇒ `needs_human`. الإنسان يشوف الـ diff ويقرر: يقبل (يتسجل كـ scope approval بأثر رجعي) أو يطلب revert. الموديل ما يقدرش يكمّل لوحده.
4. **تخطّي الميزانية:** trivial ⇒ standard: التعديلات اللي حصلت تفضل، وتتعلّم `pre_upgrade: true`، ولازم تدخل في `E-scope`. الـ lead يكتب profile + plan ويكمّل.
5. **تعديل الـ scope:** كتابة برّه `planned.scope.write` ⇒ deny. الـ lead يقدر يعمل `engos scope amend` بسبب مكتوب، بحد أقصى 2 لكل task، وبشرط المسار الجديد مش protected. غير كده ⇒ إنسان.
6. **النزول:** `/engos:class TASK-012 standard` مكتوب من الإنسان، يتسجل. `hard_gates` ما بتتأثرش.
7. كل تغيير سطر في `history` + event في الـ ledger (`class.changed` بالقاعدة المسببة).

**ليه ده بيعالج خطر الـ misclassification:** أسوأ حالة لتصنيف غلط من الموديل ("trivial" لتغيير خطر) هي إن الشغل يبدأ من غير خطة. لكن أول ما الفعل نفسه يبان (مسار، حجم، أمر) الكود بيرفع الـ class. المتبقي من الخطر: تغيير خطر **دلالياً** لكنه صغير ومش في protected path (مثلاً تغيير شرط في منطق تسعير في ملف عادي). ده الكود مش هيشوفه. التخفيف: المشروع يضيف مساراته الحساسة في `protected_paths`، والـ lexical rules. ده حد حقيقي ولازم يتقال.

### B.8 أمثلة من أول لآخر

#### مثال 1 — "غيّر اسم المتغير `tmp` إلى `buffer` في `utils/io.py`"
- `idle`. الـ lead ينادي `Edit` مباشرة (مفيش intake).
- `PreToolUse`: المسار مش protected، ملف واحد ⇒ `F-trivial` ⇒ auto task `trivial_edit`، allow، سطر ledger.
- `PostToolUse`: 6 سطور اتغيرت؛ جوّه الميزانية.
- validation بالكود: لو `config.checks.test` موجود، الـ lead يشغّله والـ hook يسجّل النتيجة؛ يتعرض ملخص الـ diff.
- إغلاق: `engos task close` ينجح لأن `E-diff-shown` و `E-checks-if-present` موجودين.
- التكلفة الزيادة: hooks فقط. صفر subagents، صفر approvals.

#### مثال 2 — تصنيف غلط: "تعديل بسيط في timeout بتاع الـ login"
- الـ lead يبدأ بـ `Edit` على `src/auth/session.ts` (شايفها trivial).
- `UserPromptSubmit` كان سجّل `L-auth-terms` ⇒ floor `standard` من قبل أي tool call.
- `PreToolUse`: المسار يطابق `**/auth/**` ⇒ `F-protected` ⇒ `high_risk` ⇒ **deny قبل التعديل**. الـ task `upgrade_pending`.
- المطلوب: profile، plan بـ `scope.write`، ثم scope approval. الـ gate ينشئ `APR-…` بـ action = `open-protected-scope TASK-013 [src/auth/session.ts]` ويعرضه للمستخدم.
- المستخدم يكتب `/engos:approve APR-…`. التنفيذ: worker على `frontier` بكارت `implementer` + كارت `security_reviewer` للـ validator (`add_when`).
- validator على `frontier` (assurance high). `E-review-record` مطلوب.
- في الآخر `git push` ⇒ `G-delivery` ⇒ approval منفصل مربوط بـ `HEAD` sha.
- النتيجة: التصنيف الغلط كلّف deny واحد، مش تعديل غير مراقَب.

#### مثال 3 — Acceptance #1: فكرة SaaS جديدة بدون repo
- ملاحظة نطاق: v0.1 = "code inside the repo". هنا مفيش repo. المطلوب مجلد فاضي + `/engos:init` (degraded: مش git لسه).
- intake: `kind: architecture`, `mutates: true` (مستندات فقط), `expected_paths: ["docs/**", ".engos/**"]`, `unknowns: [target users, scale, budget, compliance]`.
- router: `F-kind-assurance` ⇒ `assurance: high`؛ الحجم المتوقع يتخطى trivial ⇒ `standard`. `mode: workspace_write` بـ scope `docs/**` فقط.
- roles من `role_rules.architecture`: `architect` (tier `deep`) و `critic`. `unknowns` غير فاضية ⇒ أول step هو أسئلة للإنسان، مش استكشاف.
- الناتج: `docs/architecture-proposal.md` + assumptions مسجلة في `STATE.yaml` كـ `status: assumed` بمصدر `human|none`.
- evidence: `E-scope` (الكتابة في `docs/**` فقط)، `E-review-record` من الـ critic، `E-residual-risk`. مفيش tests ⇒ الـ validation كله model review، وده يتقال في التقرير النهائي.
- "requests approval before any external action": أي `gh repo create` أو `npm publish` أو `curl` ⇒ `G-delivery` ⇒ approval. `git init` محلي ⇒ `vcs_local` مسموح.
- الخطة "proportional": الـ plan skill لازم ينتج خطة بمراحل مش backlog كامل — ده advisory، مش enforced.

#### مثال 4 — Acceptance #2: تحليل مشروع قائم
- intake: `kind: analysis`, `mutates: false`.
- لو المطلوب إجابة في الشات فقط ⇒ `question`، مفيش record.
- لو المطلوب حقائق تتسجل (ده نص السيناريو) ⇒ `standard` بـ `mode: read_only`. كتابة `.engos/STATE.yaml` بتتم عن طريق `engos facts add` (CLI)، ومش محسوبة workspace write.
- steps: `S1 inventory` (`fast`, scout read-only) ⇒ `S2 synthesize` (`balanced`) ⇒ `S3 verify`.
- فصل الحقائق عن الافتراضات بالـ schema:

```yaml
facts:
  - id: F-007
    statement: "API layer uses Express 4 with 23 route files"
    status: verified          # verified | assumed
    source: {path: "package.json", line: 14}
    verified_by: code         # code | validator | human
assumptions:
  - id: A-002
    statement: "Staging shares the production database"
    status: assumed
    needs: human_confirmation
```

- validation: الكود يتحقق إن كل `source.path:line` موجود؛ validator (`balanced`) ياخد عينة من الحقائق ويتحقق من المعنى. `verified` من غير `source` ⇒ الـ CLI يرفضها.
- "proposes a scoped workflow": الناتج الأخير profile مقترح لمهمة تالية، مش تنفيذ.

#### مثال 5 — Acceptance #3: Linux troubleshooting
- ملاحظة نطاق: v0.1 ما بيشغّلش أوامر على سيرفرات حية. الـ logs بتيجي كملفات أو لصق. الأوامر التشخيصية المقترحة **ينفّذها الإنسان** ويرجّع الناتج، ويتسجل كـ evidence مصدره `human`.
- intake: `kind: debugging`, `mutates: false`, `unknowns: [root cause]`.
- router: `S1 read_logs` على `fast` (scout). ده "fast triage first".
- **التعارض مع القرار 5:** السيناريو بيقول "uncertain or cross-system findings escalate"، والقرار بيقول التصعيد عند فشل check فقط. المعالجة: نحوّل "uncertain" لـ check موضوعي على ناتج الـ triage:

```yaml
triage_check:
  - hypothesis_present: true
  - cited_lines: {min: 1, verified_verbatim_by_code: true}   # الكود يعمل grep للسطور المقتبسة
  - explains_all_reported_symptoms: validator                # validator (balanced) يحكم
  - single_component: code      # عدد المصادر/الخدمات المميزة في السطور المقتبسة == 1
```

  - فشل `cited_lines` أو `explains_all…` ⇒ `check_failed` ⇒ retry ثم tier up.
  - فشل `single_component` (cross-system) ⇒ tier up مباشرة لـ `frontier` بكارت `incident_lead`.
- كده التصعيد لسه "on failed check" وبيحقق السيناريو. **محتاج موافقة المالك** لأنه تفسير للقرار 5.
- evidence: السطور المقتبسة (verified by code)، الأوامر المقترحة، وأي ناتج رجّعه الإنسان. التقرير يفرّق بين "مرصود في الـ logs" و "فرضية".

#### مثال 6 — Acceptance #4: Security audit
- intake: `kind: security_review`, `mutates: false`.
- router: `change_risk: low`, `assurance: high` (`F-kind-assurance`). `mode: read_only` — وده **hard** للـ kind ده: أي `Edit`/`Write` على الكود ⇒ deny؛ Bash من فئة `read` + scanners معرّفة في `config.checks.security` فقط. ده بيحقق "privileged or destructive operations are not attempted" بالكود.
- roles: `security_reviewer` (`frontier`) + `evidence_validator` (`frontier`).
- schema الـ finding:

```yaml
findings:
  - id: SEC-004
    title: "SQL built by string concatenation in report export"
    severity: high            # critical|high|medium|low|info
    evidence:
      - {path: "src/reports/export.py", lines: "88-93", quote_sha256: "sha256:…"}
    reproduction: "static: user-controlled `sort` reaches cursor.execute unescaped"
    remediation: "parameterize; allowlist sort columns"
    priority: 1
    validated: {by: evidence_validator, verdict: confirmed}   # confirmed|not_reproduced|downgraded
```

- validation مستقل: الكود يتحقق إن كل `evidence` موجود ومطابق للـ hash؛ الـ validator يعيد التحقق من كل `critical/high` وعينة من الباقي. `not_reproduced` ⇒ نزاع (القسم C)، وفي الـ kind ده النزاع يروح للإنسان.
- الإصلاح مهمة جديدة: الـ audit ما يعدّلش. كل fix يتفتح كـ task، وغالباً `high_risk`.

---

## 4) القسم C — إزاي الـ lead يحدد المسؤولية

### C.1 المبادئ

1. **accountability ما تتفوّضش.** الـ lead (الـ main session) مسؤول عن نتيجة الـ task داخل الجلسة. الـ subagent مسؤول عن ناتج **step**، مش عن النتيجة. الإنسان هو المسؤول النهائي عن القبول وعن كل ما له أثر خارج الـ repo.
2. **الكاتب لا يراجع نفسه.** أي تغيير كتبه طرف، التحقق منه يكون بالكود أو بطرف تاني.
3. **الـ lead مش حَكَم محايد.** عنده دافع ينهي المهمة. عشان كده سلطته في النزاعات محدودة بقواعد ومسجلة.
4. **كل نقل مسؤولية event.** مفيش "ضمني".

### C.2 ثابت بقواعد مقابل متروك لحكم الـ lead

| ثابت (كود) | حكم الـ lead |
| --- | --- |
| الـ class والـ mode والـ tier لكل step (router) | تقسيم المهمة لـ steps وترتيبها |
| الحد الأدنى للـ roles لكل kind | إضافة roles زيادة |
| الحد الأدنى للـ evidence لكل class | صياغة الـ acceptance criteria فوق الحد الأدنى |
| مين ينفّذ: trivial ⇒ lead؛ standard+ ⇒ worker | صياغة الـ brief واختيار الـ inputs |
| schema الـ handoff | هل يقبل تقرير "done" ولا يطلب توضيح |
| عدد الـ cycles وترتيب التصعيد | تشخيص نوع الفشل (في حدود التصنيف A11) |
| حدود سلطة الـ lead في النزاع (C.5) | القرار نفسه داخل الحدود |
| متى يُنقل للإنسان (C.6) | إزاي يعرض الخيارات والتوصية |
| الانتقال لـ `complete` (CLI بشروط) | نص التقرير النهائي والـ residual risk |
| الـ criteria ما تتغيرش بعد بدء التنفيذ إلا بـ amendment | اقتراح الـ amendment |

### C.3 الـ lead ينفّذ بنفسه ولا يفوّض؟

قاعدة ثابتة (كود يتحقق منها):

| الحالة | المنفّذ | السبب |
| --- | --- | --- |
| `question` | lead | مفيش ما يتفوّض |
| `trivial_edit` | lead | تكلفة spawn أكبر من الشغل نفسه |
| `standard` / `high_risk` — steps التنفيذ | worker | عزل context + فصل الكاتب عن المراجع |
| قراءة كثيفة (logs كبيرة، بحث واسع) في أي class | scout (`fast`) | حماية context الـ lead |
| intake، plan، دمج النتائج، الحوار مع الإنسان | lead دائماً | هو صاحب السياق والمسؤولية |
| "integration edit" داخل standard+ | lead، في حدود ميزانية trivial، ويتعلّم `by: lead` | إصلاح صغير بعد worker من غير spawn جديد |

الإنفاذ: في `standard`+ أي `Edit`/`Write` من الـ main thread (مفيش `agent_id` في hook input) بيتحسب من ميزانية integration؛ لو خلصت ⇒ deny مع "فوّض الـ step". والتعديلات دي لازم تتغطى بـ `E-checks` بعد آخر تعديل (الكود يتأكد إن آخر check run أحدث من آخر edit).

**خيار إضافي [موثَّق كآلية، غير مختبر هنا]:** agent اسمه `engos:lead` بـ `tools: Agent(scout, worker, validator), …` يشتغل كـ main thread (`claude --agent` أو `"agent"` في settings). كده المنصة نفسها تمنع الـ lead من spawn لغير الـ agents بتاعة النظام. العيب: بيستبدل system prompt الجلسة وبيأثر على كل الجلسات لو اتفعّل من الـ plugin. أوصي بيه opt-in في `/engos:init`، مش default.

### C.4 عقد الـ handoff

بيغطي الحقول السبعة في `config/agents.yaml` (objective, scope, inputs_read, outputs_changed, evidence, limitations, next_action) لكن بيفصل بين اتجاهين.

**Brief (lead ⇒ subagent)** — الجزء الثابت يولّده `engos step brief` من الـ profile، والـ lead يملى الحر:

```yaml
schema: engos/brief@1
task_id: TASK-012
step_id: S2
attempt: 1
role: implementer            # الكارت يتحقن بـ SubagentStart hook
tier: balanced               # من الـ router؛ الـ hook يتحقق من subagent_type و model
objective: "Refresh session expiry on authenticated activity"
scope:
  write: ["src/session/**", "tests/session/**"]
  read:  ["src/**"]
  non_goals: ["no change to token format"]
inputs:
  - {ref: "src/session/refresh.ts", why: "current refresh logic"}
  - {ref: ".engos/tasks/TASK-012/S1.report.yaml", why: "root cause location"}
acceptance:
  - {id: AC-1, check: "config.checks.test -- tests/session", expect: pass}
  - {id: AC-2, statement: "expiry extends on activity", verified_by: validator}
prior_failure: null          # عند retry: الـ output الحرفي للـ check الفاشل + verdict الـ validator
limits: {max_turns: 40}
return: engos/report@1
```

**Report (subagent ⇒ lead)** — آخر رسالة من الـ subagent؛ `SubagentStop` hook يقرأ `last_assistant_message` **[موثَّق أن الحقل موجود]** ويتحقق من الـ schema ويخزّنه:

```yaml
schema: engos/report@1
task_id: TASK-012
step_id: S2
status: done                 # done | blocked | needs_reclass | disputes_criterion
inputs_read: ["src/session/refresh.ts", "src/session/store.ts"]
outputs_changed:             # ادعاء؛ الكود يقارنه بالمرصود لنفس agent_id
  - "src/session/refresh.ts"
  - "tests/session/refresh.test.ts"
evidence:                    # مراجع لأحداث ledger، مش سرد
  - {ac: AC-1, ledger_event: "evt-0193"}
limitations: ["did not test clock skew"]
assumptions: ["store.touch() is atomic"]
next_action: "validate AC-2"
```

قواعد:
- `outputs_changed` المدّعى لازم يطابق المرصود. فرق ⇒ الـ lead يتبلّغ بيه نصاً، ويتسجل.
- `evidence` من غير `ledger_event` حقيقي ⇒ الـ CLI يرفض اعتبار الـ AC متحقق. ده تطبيق "narrative alone is insufficient".
- هل `SubagentStop` يقدر يمنع الانتهاء ويطلب تقرير سليم؟ **[غير متحقق]**. البديل: الـ lead يطلب إعادة التقرير.

### C.5 النزاع بين worker و validator

| الحالة | مثال | مين يحسم | القيد |
| --- | --- | --- | --- |
| check تنفيذي فشل | test أحمر | محدش — دي حقيقة | retry / tier up |
| ملاحظة حُكمية من الـ validator، والـ worker ما اعترضش | "الـ AC-2 مش متغطي" | الـ validator | retry مع الملاحظة |
| ملاحظة حُكمية والـ worker معترض، class = `standard` | "ده برّه الـ scope" | **lead** | يسجّل `uphold` أو `overrule` بسبب مكتوب؛ `overrule` مرة واحدة لكل task، وبيظهر في التقرير النهائي كـ residual risk |
| نفس الحالة، class = `high_risk` | — | **إنسان** | اختياري قبلها: validator تاني tier أعلى كرأي ثالث |
| ملاحظة أمنية ≥ medium في أي class | — | **إنسان** | الـ lead ما يقدرش يعمل overrule |
| scope violation على protected path | — | **إنسان** | — |
| الـ criterion نفسه غلط أو الـ test flaky | — | `standard`: lead بـ amendment مسجّل + إعادة تحقق. `high_risk`: إنسان | الـ amendment ما ينفعش يشيل check من الحد الأدنى للـ class |
| validator قال `not_reproduced` على security finding | — | **إنسان** | — |

اللي الـ lead **ما يقدرش** يعمله أبداً: يتجاوز check تنفيذي فاشل، يعدّل criteria من غير amendment، يعلّم complete (الـ CLI بيحسبها)، يمنح approval، ينزّل class.

### C.6 متى تنتقل المسؤولية للإنسان

| المحفّز | نوع الطلب | الحالة |
| --- | --- | --- |
| action تحت `G-delivery` أو فتح protected scope | `APR-…` (approval) | `awaiting_approval` |
| استنفاد 3 cycles | `DEC-…` (decision) | `blocked` |
| نزاع من الأنواع المخصصة للإنسان | `DEC-…` | `needs_human` |
| violation مرصود بعد التنفيذ | `DEC-…` (accept / revert) | `needs_human` |
| amendment لـ criteria أو scope في `high_risk` | `DEC-…` | `needs_human` |
| طلب تنزيل class | أمر مكتوب | — |
| غموض في المتطلبات يغيّر الـ scope | سؤال عادي | `needs_input` |
| تخطّي ميزانية الـ spawns | `DEC-…` | `needs_human` |
| اكتشاف secret في diff أو state | `DEC-…` | `needs_human` |
| أي حاجة برّه نطاق v0.1 (ops، production) | رفض + شرح | `out_of_scope` |

حزمة التسليم (يولّدها الكود من الـ ledger، والـ lead يضيف التوصية):

```yaml
schema: engos/handover@1
decision_id: DEC-004
task_id: TASK-012
reason: cycles_exhausted
tried:
  - {step: S2, attempt: 1, tier: balanced, result: "AC-1 failed", ledger_event: evt-0193}
  - {step: S2, attempt: 2, tier: balanced, result: "AC-1 failed", ledger_event: evt-0201}
  - {step: S2, attempt: 3, tier: frontier, result: "AC-1 failed", ledger_event: evt-0214}
state: {diff_files: 2, checks_passing: ["lint"], checks_failing: ["test:tests/session"]}
options:
  - {id: a, text: "allow one more cycle on deep tier"}
  - {id: b, text: "amend AC-1 (test asserts old behaviour)"}
  - {id: c, text: "stop; keep diff on branch"}
lead_recommendation: {option: b, why: "failing assertion encodes the bug"}
```

قرارات `DEC` بتتسجل بنفس قناة الـ approvals (أمر مكتوب + hook)، بنفس التحفظات في A2. بعد القرار: `responsibility.transferred` بيرجع للـ lead مع القيد اللي الإنسان اختاره.

### C.7 التسجيل للـ audit

- ملف واحد append-only (`ledger.jsonl`)، بيكتبه hooks والـ CLI فقط، كل سطر فيه `prev_hash`.
- كل event فيه `actor` صريح. `owner` الحالي للـ task دايماً يتحسب من آخر `responsibility.*` event.

```yaml
# سطر واحد (معروض YAML للقراءة)
id: evt-0214
at: 2026-11-12T10:41:07Z
task_id: TASK-012
type: step.ended
actor: {kind: worker, agent_id: "ag_7f…", agent_type: "engos:worker", model_requested: opus, model_actual: unknown}
data: {step: S2, attempt: 3, status: done, duration_ms: 184000, tool_calls: 37}
prev_hash: "sha256:…"
```

أنواع الأحداث:

| النوع | مين يكتبه | أهم الحقول |
| --- | --- | --- |
| `task.opened` / `task.closed` | hook / CLI | `opened_by`, `class`, شروط الإغلاق المتحققة |
| `profile.declared` | CLI | `declared` كامل |
| `class.changed` | hook | `from`, `to`, `rule_id`, `trigger` |
| `step.assigned` | CLI | `step`, `role`, `tier`, `rule_id`, `owner` |
| `step.started` / `step.ended` | hook | `agent_id`, `model_requested`, `model_actual` |
| `gate.denied` | hook | `tool`, `rule_id`, input hash |
| `evidence.recorded` | hook | `ac`, `command`, `exit`, `output_sha256` |
| `validation.verdict` | hook (من report) | `verdict`, `findings` |
| `dispute.opened` / `dispute.resolved` | CLI | `parties`, `resolved_by: lead\|human`, `decision`, `reason` |
| `criteria.amended` / `scope.amended` | CLI | `before`, `after`, `by`, `reason` |
| `approval.requested/granted/rejected/used/expired` | hook | `approval_id`, `action_hash`, `origin_event` |
| `responsibility.transferred` | CLI / hook | `from`, `to`, `reason`, `decision_id` |
| `engos.paused` / `engos.resumed` | hook | `by: human` |

`model_actual: unknown` مقصود: ما نكتبش موديل ما اتأكدناش منه (A4).

### C.8 RACI لكل class

R = ينفّذ، A = مسؤول عن النتيجة، C = يُستشار، I = يُبلَّغ. "Code" = router / gate / hooks / CLI.

**`question`**

| النشاط | Human | Lead | Worker | Validator | Code |
| --- | --- | --- | --- | --- | --- |
| التصنيف | — | — | — | — | R/A (ضمني: مفيش mutation) |
| الإجابة | I | R/A | R (scout لو قراءة كثيفة) | — | — |
| التحقق | — | — | — | — | — |

**`trivial_edit`**

| النشاط | Human | Lead | Worker | Validator | Code |
| --- | --- | --- | --- | --- | --- |
| التصنيف | — | — | — | — | R/A |
| التنفيذ | I | R/A | — | — | يراقب الميزانية |
| التحقق | I | يشغّل الـ checks | — | — | R/A (يسجّل ويقرر) |
| الترقية لو اتخطت الميزانية | I | C | — | — | R/A |
| الإغلاق | I | R | — | — | A (شروط) |
| action خارجي (push) | **A** (approval) | R (يطلب وينفّذ) | — | — | يمنع ويسجّل |

**`standard`**

| النشاط | Human | Lead | Worker | Validator | Code |
| --- | --- | --- | --- | --- | --- |
| intake / profile | C (لو فيه unknowns) | R | — | — | A على `effective` |
| الخطة والـ criteria | I | R/A | — | — | يفرض الحد الأدنى |
| اختيار tier و roles | — | C (يضيف roles) | — | — | R/A |
| التنفيذ | I | A | R | — | gate |
| التحقق | I | A | C | R (الحُكمي) | R (التنفيذي) |
| حسم نزاع حُكمي | I | R/A (مرة واحدة) | C | C | يسجّل ويحدّ |
| amendment للـ criteria / scope | I | R/A | C | C | يسجّل ويحدّ |
| بعد 3 cycles | **A** | R (حزمة التسليم) | — | — | يوقف |
| الإغلاق | I | R | — | — | A (شروط) |
| action خارجي | **A** | R | — | — | يمنع ويسجّل |

**`high_risk`**

| النشاط | Human | Lead | Worker | Validator | Code |
| --- | --- | --- | --- | --- | --- |
| intake / profile | C | R | — | — | A على `effective` |
| الخطة والـ criteria | C | R/A | — | — | يفرض الحد الأدنى |
| فتح protected scope | **A** (scope approval) | R (يطلب) | — | — | يمنع ويسجّل |
| التنفيذ | I | A | R | — | gate |
| التحقق | I | A | C | R | R (التنفيذي) |
| حسم أي نزاع | **R/A** | C (توصية) | C | C | يسجّل |
| amendment | **A** | R (يقترح) | C | C | يسجّل |
| قبول violation مرصود | **R/A** | C | — | — | يوقف |
| الإغلاق | **A** (acknowledgement) | R | — | — | شروط |
| action خارجي | **A** لكل action | R | — | — | يمنع ويسجّل |

---

## 5) أسئلة مفتوحة للمالك

### ما أراه متعارضاً مع قرارات محسومة (بوضوح)

1. **القرار 4 — آلية الالتقاط.** `UserPromptSubmit` لوحده لا يثبت أن إنسان كتب (A2). المبدأ سليم؛ الآلية محتاجة تتغير. هل توافق على: `UserPromptExpansion` + request يكتبه الـ gate + ID مشتق من الـ hash + منع `claude` من Bash؟ وهل نضيف `permissionDecision: "ask"` كدرجة تأكيد أخف؟
2. **القرار 4 — "per exact action, single-use".** لتغطية `security_sensitive_change` في `config/policies.yaml` اقترحت "scope approval": موافقة واحدة تفتح مسارات protected محددة لـ task واحد لحد إغلاقه. ده مش single-use لكل edit. البديل (approval لكل edit) غير عملي. موافق؟
3. **القرار 5 — "escalation only on failed checks".** متعارض مع acceptance scenario 3 ومع `config/routing.yaml` الأصلي. اقترحت تحويل "uncertain / cross-system" لـ checks موضوعية (مثال 5). تقبل التفسير ده، ولا يتعدل السيناريو؟
4. **القرار 5 — عدّ الـ cycles.** "3 cycles" بالصيغة الحالية ما توصلش `deep` من `balanced`. الـ 3 لكل step ولا لكل tier؟ وهل `env_error` ما يتحسبش؟
5. **القرار 5 — per-tier subagents.** بسبب `model` parameter في `Agent`، ملفات الـ tiers مش هي الإنفاذ؛ الـ hook هو الإنفاذ. تفضّل 6 ملفات (default آمن + `effort` لكل tier) ولا 3 ملفات بـ `model` parameter (A18)؟
6. **القرار 5 — "main session stays on one model".** الـ plugin ما يقدرش يفرضها. نكتفي بتوصية + تحذير عند `PreModelSwitch`؟
7. **القرار 2 — مكان الحالة.** أوصي بنقل approvals + ledger إلى `${CLAUDE_PLUGIN_DATA}` برّه الـ repo (A3). ده بيخالف "project state lives in `.engos/`" جزئياً، وبيخلّي الـ audit trail مش مشترك في الفريق عن طريق git. أنهي أهم: مقاومة التلاعب ولا المشاركة؟ (حل وسط: export موقَّع بالـ hash chain للـ repo عند إغلاق الـ task.)
8. **القرار 3 — النطاق مقابل الـ acceptance scenarios.** السيناريو 1 (بدون repo) والسيناريو 3 (Linux troubleshooting) على حافة "code inside the repo only". يتعدلوا ولا يتعلّموا "partial in v0.1"؟

### قرارات جديدة مطلوبة

9. **Threat model معلن.** هل الهدف منع الأخطاء والـ prompt injection العرضي (ممكن بالـ hooks)، ولا مقاومة موديل بيحاول يتجاوز عمداً (محتاج OS sandbox)؟ الإجابة بتحدد صياغة الـ README وكل ادعاء "enforced".
10. **الحد الأدنى لنسخة Claude Code.** `onFailure: block` محتاج v2.1.295+. مقبول كشرط تثبيت؟
11. **لغة الـ hooks.** Node ملف واحد دلوقتي بعقد stdin/stdout ثابت، وGo binary بعدين؟ (A20)
12. **`bin/`** بيمنع التثبيت على claude.ai و Cowork. المنتج Claude Code CLI/Desktop فقط؟
13. **`unknown` Bash = allow + observe.** موافق على التمن (كشف بعد التنفيذ)، ولا تفضّل `ask` لكل أمر غير معروف مع friction أعلى؟
14. **قيم الميزانيات** (`trivial_edit`: ملفين / 40 سطر) و **قائمة `protected_paths` الافتراضية** — أرقام مقترحة من غير بيانات. محتاجة تجربة على repos حقيقية.
15. **إيه اللي يتعمله commit من `.engos/`؟** اقتراحي: `config.yaml`, `BRIEF.md`, `STATE.yaml` فقط.
16. **`/engos:pause`.** مين يقدر يوقف الـ gate، ولمدة قد إيه (session ولا دائم)، وهل الـ `hard_gates` تفضل شغالة أثناء الـ pause؟ اقتراحي: تفضل شغالة.
17. **الـ lead كـ main-thread agent (`engos:lead`).** opt-in في init ولا خارج v0.1؟
18. **اسم النشر.** `claude` ككلمة في الاسم بيطلّع warning في `claude plugin validate`. `engos` كـ `name`؛ إيه الـ `displayName`؟
19. **اختبارات لازم تتعمل قبل تثبيت التصميم** (كلها **[غير متحقق]** في التقرير):
    - هل `UserPromptExpansion` بيشتغل على رسالة من session تانية / scheduled task / `claude -p`؟
    - هل deny من `PreToolUse` بيتطبق في `bypassPermissions` و `auto`؟ وسلوك `ask` فيهم وفي headless.
    - هل `systemMessage` بيتكتب في ملف الـ transcript؟
    - حقول `SubagentStop` الكاملة، وهل يقدر يمنع الانتهاء؛ وهل فيه مصدر موثوق للموديل الفعلي.
    - `stop_hook_active` وسلوك `Stop` مع background subagents مفتوحة.
    - شروط ظهور `bashEditDiff` في `PostToolUse`.
    - توفر sandbox على Windows.
    - زمن الـ gate الفعلي (p95) على Windows مع Node.

---

**حدود هذه المراجعة:** لم يُنفَّذ أو يُختبر أي شيء. ادعاءات المنصة مبنية على قراءة جزئية للوثائق (صفحة hooks طويلة ولم تُقرأ كاملة؛ قسمي `Stop` و `SubagentStop` تحديداً لم يُراجعا نصاً). الأرقام في الـ rule table (ميزانيات، حدود) اقتراحات أولية بدون قياس.

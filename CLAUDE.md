# 规则

- 先和我讨论、确认任务的需求和设计，再开始实现。
- 架构和实现保持极简：只为本质复杂度写代码；不加用不到的抽象、配置、依赖和防御性代码；能复用就不新建，能删就不加。
- 把大任务拆成可以验收边界清晰的小目标再实现。
- commit、PR 和文档保持极简：只写核心观点和本质复杂度，不讨论偶然复杂度；git/GitHub 上的交互（commit、PR、issue、评论）用英文。
- 优先用中文回答我的问题；回复简洁，只讲要点。
- session 结束前，把没解决完的问题和打算以后做的事直接在 GitHub 提 issue 记录（每件事一个，只写是什么、为什么）；先查重，已有就在原 issue 下补充。
- 改 UI 前先读设计系统 `site/design.html` 和 `site/avatars.html`（线上 https://fanzhangg.github.io/open-doc/design.html），严格按它的规则改；系统本身要变时，先改它和 `web/app.css` 的 tokens，再改界面。

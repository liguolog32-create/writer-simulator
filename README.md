# 作家模拟器 (Writer Simulator)

多画布并行编辑的协作写作工具 — Demo 版。

## 快速开始

```bash
cd writer-simulator
npm install
npm run dev    # 本地预览，浏览器打开 http://localhost:5173
npm run build  # 产出静态站点到 dist/
```

## 这个 demo 有什么

- 7 块画布（设定 / 人物 / 文笔 / 结构 / 篇幅 / 情节 / 节奏）并行编辑
- 画布之间可手动连线，一处改动会级联到下游画布
- 顶部「只读访客 / 管理后台」两种模式切换，演示"一个链接两种入口"
- 「书库类型」栏目展示 51 个题材/作者分类
- 数据持久化到浏览器 localStorage

## 技术栈

- React 18 + TypeScript + Vite
- 状态管理：useReducer + Context
- 样式：原生 CSS（无第三方 UI 库）
- 持久化：localStorage

## 接下来

1. 上传到 GitHub（见下方指引）
2. 部署到 Vercel / Cloudflare Pages（自动开启分支预览）
3. 接真后端（Node.js + Express / FastAPI）
4. 接百度网盘语料库
5. AI 模型接入（画布解析、范文推荐、特征提取）

## 上传到 GitHub 仓库的两种方式

### 方式 A：GitHub Desktop（推荐，最简单）

1. 安装 GitHub Desktop：<https://desktop.github.com>
2. 登录你的 GitHub 账号
3. File → Add local repository → 选择本项目文件夹
4. 如果提示创建，点 "create a repository"
5. 点 "Publish repository"，选择目标账号与仓库名

### 方式 B：网页版逐文件创建

适合不愿装客户端：

1. 打开 GitHub 仓库页面（如 `github.com/liguolog32-create/-`）
2. 点 "Add file" → "Create new file"
3. 把本项目每个文件的内容粘贴进去，文件名一一对应
4. 提交

### 方式 C：命令行（需要装 git）

```bash
cd writer-simulator
git init
git add .
git commit -m "init: writer simulator demo"
git remote add origin https://github.com/liguolog32-create/-.git
git push -u origin main
```

## 部署到 Vercel（开启预览部署）

1. 登录 <https://vercel.com>，用 GitHub 账号授权
2. Import 你的仓库
3. Framework Preset 选 "Vite"
4. 点 Deploy
5. 部署完成后，每次你推新分支或开 PR，Vercel 自动生成独立预览链接

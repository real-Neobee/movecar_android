# MoveCar_Android - 挪车通知系统（安卓优化版）

基于 Cloudflare Workers 的智能挪车通知系统，扫码即可通知车主，保护双方隐私。

> 本版基于 [原项目](https://github.com/lesnolie/movecar) 进行优化调整，核心架构不变，仅对国内安卓用户使用体验和交互逻辑进行了多项改进，并更新部署教程。

## 界面预览

|                        路人页面                         |                         车主页面                         |
| :-------------------------------------------------------: | :------------------------------------------------------: |
| [🔗 在线预览](https://preview.movecar.neobee.org/sender_preview) | [🔗 在线预览](https://preview.movecar.neobee.org/owner_preview) |

## 与原版的主要区别

### 🔔 推送服务：Bark → Server酱

原版使用 Bark（仅 iOS），本版改用 **Server酱** 推送至微信，适合国内安卓用户。

- 推送正文支持 Markdown，确认链接在微信消息内可直接点击跳转

### ⏱️ 无位置延迟：30 秒 → 5 分钟

未分享位置时的延迟发送时间由 30 秒延长至 **5 分钟**，进一步降低恶意骚扰的动力。弹窗说明和 Toast 提示均已同步更新。

### ✏️ 输入框：textarea → contenteditable

将普通文本框改为富文本编辑区，支持在同一输入框内混合显示普通文本和**红色加粗的加急提示**。

### 🏷️ 标签交互逻辑重写

原版四个标签（挡路 / 临停 / 没接 / 加急）点击后直接覆盖输入内容，本版进行了完整重写：

| 功能                 | 原版                           | 优化版                               |
| -------------------- | ------------------------------ | ------------------------------------ |
| 标签数量             | 4 个（含"没接"）               | 3 个                                 |
| 加急                 | 覆盖全部内容                   | 追加到文本末尾，红色加粗             |
| 已输入内容           | 点击标签会清空文本套用模板文字 | **在光标处插入**，不影响已有内容     |
| 先点加急再点其他标签 | 加急文本被替换为其他模板文字   | **检测光标位置**，插入到模板文字之前 |
| 选中反馈             | 无                             | 选中标签变色                         |

### 🎨 其他界面调整

- 预览链接添加交互
- 三个标签**整体居中**，间距等比自适应屏幕，支持小屏换行
- 位置获取失败时提示文案更具体："刷新页面重试或复制链接到浏览器打开"，（微信网页刷新后保持位置获取状态）
- 模板字符串加入 `/*html*/` 标记，VS Code 可对内嵌 HTML 完整高亮

## 部署步骤

### 第一步：注册 Cloudflare 账号

1. 打开 https://dash.cloudflare.com/sign-up
2. 输入邮箱和密码，完成注册

### 第二步：创建 Worker

1. 登录完成邮箱验证后，点击左侧菜单『Workers & Pages』
2. 点击『Create application』
3. 选择『Start with Hello World!』
4. 点击『Deploy』
5. 点击『Edit code』，删除默认代码
6. 复制 `movecar_android.js` 全部内容，粘贴
7. 点击右上角『Deploy』保存

### 第三步：创建 KV 存储

1. 左侧菜单『Storage & databases』→『Workers KV』
2. 点击『Create instance』
3. 名称填 `MOVE_CAR_STATUS`，点击『Create』
4. 回到你的 Worker →『Bindings』
5. 点击『Add binding』,左侧选择『KV Namespace』→『Add binding』
6. Variable name 填 `MOVE_CAR_STATUS`，KV Namespace选择刚创建的 namespace`MOVE_CAR_STATUS`，点击『Add binding』

### 第四步：配置环境变量

_!!! 请先前往 [sct.ftqq.com](https://sct.ftqq.com) 微信扫码登录获取 SendKey_

在 Cloudflare Worker → Settings → Variables and Secrets 中添加：

| Variable name  | Value          | 是否必填 |
| -------------- | -------------- | -------- |
| `SC_KEY`       | 提供的SendKey  | 必填     |
| `PHONE_NUMBER` | 车主的联系电话 | 可选     |

### （可选项）

#### 绑定域名（建议，加快国内访问速度）

1. Worker →『Settings』→『Domains & Routes』
2. 点击『Add』→『Custom Domain』
3. 输入你的域名，按提示完成 DNS 配置

> 获得免费域名或购买域名等方法自行查找

#### 使用WAF规则防护（建议，防止境外恶意攻击）

1. 进入 Cloudflare Dashboard → 你的域名
2. 左侧菜单点击『Security』→ 『Security rules』
3. 点击『Create rule』→『Custom rules』
4. 规则设置：
   - Rule name: `Block non-CN traffic` / `阻止境外访问`
   - Field: `Country`
   - Operator: `does not equal`
   - Value: `China`
   - Choose action: `Block`
5. 点击『Deploy』

#### 修改 Worker 名称

1. Worker →『Settings』→『General』
2. 点击『Rename』，输入想更改的名称

## 生成挪车二维码

1. 复制你的 Worker 地址（如 `https://movecar.你的账号.workers.dev`）
2. 使用任意二维码生成工具（如 https://www.toolhelper.cn/QRCode/Generate）
3. 将链接转换为二维码并下载
4. 可使用工具添加背景、文字等美化

## License

MIT

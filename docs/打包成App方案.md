# 打包成 App 方案（锁定横屏 · 内容走线上网址）

> 目标站点：`https://graduate.dpdns.org`（GitHub Pages）
> 已选路线：**Capacitor 8 打 Android App** · **锁定横屏** · **打开就加载线上网址**
> 本文只是方案，未动任何代码。确认后再开工。

---

## 结论速览

| 问题 | 答案 |
| --- | --- |
| 能不能打包成 App？ | **能**。本机 Java 21 + Node 22 都满足，只差 Android SDK 组件（约 1 GB 下载）。 |
| 横屏能解决吗？ | **能，而且只有打包能解决**。网页端（含 PWA）永远锁不了方向，App 壳可以真锁。 |
| 服务端要改吗？ | **不用**。中继已是 `wss://`，账号接口 CORS 是 `*`，两种内容模式都不会挂。 |
| iOS 能做吗？ | **本机做不了**。Capacitor 8 要求 Xcode 26 + macOS，Windows 只能生成工程。 |
| 需要动客户端代码吗？ | **需要**，而且工作量主要在 UI —— 现在这套手机 UI 是**按竖屏单手操作设计的**（见第五节）。 |

---

## 一、"网站不会横屏"的真相

这不是 bug，是浏览器的硬限制。所有网页侧手段都只能"响应"方向，不能"改变"方向：

| 手段 | 能强制横屏吗 | 说明 |
| --- | --- | --- |
| CSS `@media (orientation: landscape)` | ❌ | 只能**针对**方向做样式，不能改变方向 |
| `<meta name="orientation" content="landscape">` | ❌ | **已被废弃**，主流浏览器全都不认 |
| `screen.orientation.lock('landscape')` | ⚠️ | 必须先 `requestFullscreen()` 成功；**iOS Safari 完全不支持**；Chrome for Android 支持，但一退出全屏就失效 |
| **原生 App 壳** | ✅ | `AndroidManifest.xml` / `Info.plist` 说了算，**真锁**，用户转不了 |

所以纯网页（包括 PWA）唯一能做的是**引导**：竖屏时盖一层"请把手机横过来"的遮罩（旋转图标 + 文案），可选加一个"进入横屏"按钮去尝试 `requestFullscreen()` + `lock()`（iOS 上会失败，得降级成纯提示）。

**要真横屏，只能打包。** 这反而是本次需求里打包最实在的收益。

---

## 二、三条路线对比

| | A. Capacitor 打 APK（本次选择） | B. PWA 加到主屏 | C. 极简 WebView 壳 |
| --- | --- | --- | --- |
| 锁横屏 | ✅ 原生 Manifest 真锁 | ❌ 锁不了 | ✅ 但要自己写 Manifest |
| 全屏沉浸 | ✅ 可隐藏状态栏/导航栏 | ⚠️ 部分 | ✅ |
| 首次装包 | 需下 ~1GB SDK | 秒装 | 需下 ~1GB SDK |
| 离线可玩 | 取决于内容模式（本次选了在线） | ✅ 有 SW 就行 | 同左 |
| 后续维护 | 原生工程 + Web 工程两套 | 只有 Web | 要维护 Java/Kotlin |
| 插件生态 | ✅ 官方插件齐全 | — | ❌ 全靠手写 |
| 上架可行性 | ⚠️ 走在线阅读时有风险（见第七节） | ❌ 上不了商店 | ⚠️ 同 A |

**结论**：你选的 A 是对的。B 满足不了横屏；C 省不了多少事却要自己写原生代码。

---

## 三、本机环境体检（实测）

| 项 | 状态 |
| --- | --- |
| Node.js 22.22.2 | ✅ 满足（Capacitor 8 要求 Node ≥ 22） |
| Java 21.0.11 LTS | ✅ 满足（AGP 要求 JDK 17+） |
| `ANDROID_HOME` | ✅ 已设为 `C:\Users\Administrator\AppData\Local\Android\Sdk` |
| Android SDK 内容 | ❌ **空壳**：`cmdline-tools\latest` 是**空目录**，没有 `platform-tools` / `platforms` / `build-tools` |
| Gradle | ❌ 未安装 —— **不用单独装**，Capacitor 的 Android 工程自带 gradle wrapper |
| Android Studio | ❌ 未安装 —— **命令行也能构建**，官方只是"推荐"装 |
| npm registry | ✅ 可访问（已实测 `npm view @capacitor/core` → 8.5.2） |
| macOS / Xcode | ❌ 无 → iOS 只能出工程，出不了 `.ipa` |

要补的 SDK 组件（命令行工具方式，不必装 Android Studio）：

```bash
# 1) 下载 commandline-tools（Windows 版）并解压到：
#    %LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest\
#    下载页：https://developer.android.com/studio#command-tools

# 2) 用 sdkmanager 装组件（约 1GB）
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"

# 3) 接受许可
sdkmanager --licenses
```

> Capacitor 8 要求 `minSdk` ≥ 24（Android 7），当前稳定 API 是 36（Android 16）。
> 建议把 `minSdk` 提到 **26**（Android 8）甚至 **30**，理由见第六节第 5 条。

---

## 四、实施步骤（Capacitor 8 + 加载线上网址）

### 4.1 装依赖

```bash
cd "E:/玩法/first-person-mover"
npm i -D @capacitor/cli
npm i @capacitor/core @capacitor/android @capacitor/screen-orientation
```

> 注意：本项目 `src/` 与 Capacitor 的 `android/` 工程可以共存，`dist/` 已存在且被 `.gitignore` 忽略。

### 4.2 初始化并添加 Android 平台

```bash
npx cap init "第一人称移动" org.dpdns.graduate.fpm --web-dir=dist
npx cap add android
npx cap sync android
```

### 4.3 `capacitor.config.json`（只列关键字段）

```json
{
  "appId": "org.dpdns.graduate.fpm",
  "appName": "第一人称移动",
  "webDir": "dist",
  "server": {
    "url": "https://graduate.dpdns.org",
    "androidScheme": "https",
    "cleartext": false
  },
  "android": {
    "allowMixedContent": false
  },
  "plugins": {
    "ScreenOrientation": { "orientation": "landscape" }
  }
}
```

- `server.url` → WebView 直接加载线上站点，**改网站 App 即时生效**，且 origin 就是 `https://graduate.dpdns.org`（与网页版同源，CORS/登录行为完全一致）。
- `webDir` 仍是必填，即使在线模式下用不到（构建时还是要有 `dist/`）。
- `cleartext: false` 保持明文流量关闭（我们全走 `https`/`wss`）。

### 4.4 锁横屏（核心，三处按需）

**(1) 主锁 —— Android 清单文件**（最彻底，改一次永久生效）

`android/app/src/main/AndroidManifest.xml`：

```xml
<activity
    android:name=".MainActivity"
    android:screenOrientation="sensorLandscape"
    android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode|navigation|density"
    android:exported="true"
    ... >
```

- `sensorLandscape` —— **推荐**。锁定在"横屏"范围内，但允许用户在**左右两个横屏方向**之间跟随重力切换（谁横着拿手机方向不定，这个最舒服）。
- `landscape` —— 死锁一个方向（比如统一向右横）。
- ⚠️ **`configChanges` 里的 `orientation|screenSize` 千万不能删**，否则旋转时 Activity 会被重建，整局游戏状态清零。

**(2) 运行时可调用 —— 官方插件**

```js
import { ScreenOrientation } from '@capacitor/screen-orientation';
// 原生平台才存在，Web 上要判空
await ScreenOrientation.lock({ orientation: 'landscape' });
```

适合"首页竖屏、进游戏锁横屏"这类动态需求。本方案既然全锁横屏，(1) 就够了，(2) 只是备用。

**(3) iOS（将来有 Mac 时）**

`ios/App/App/Info.plist` 的 `UISupportedInterfaceOrientations` 只留：

```xml
<array>
  <string>UIInterfaceOrientationLandscapeLeft</string>
  <string>UIInterfaceOrientationLandscapeRight</string>
</array>
```

### 4.5 构建 APK

```bash
npx cap sync android
cd android && ./gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

debug 包用自带的 debug keystore 签名，**能直接装手机**。
要发布/分享给别人长期装，再生成正式签名：

```bash
keytool -genkey -v -keystore fpm.keystore -alias fpm -keyalg RSA -keysize 2048 -validity 10000
# 然后在 android/app/build.gradle 里配 signingConfigs，再 ./gradlew assembleRelease
```

---

## 五、锁横屏后，UI 必须跟着改的地方（**主要工作量在这**）

现在这套手机 UI 是**竖屏单手操作**设计的。锁死横屏后，下面这些都跑在 780×360 这样的比例里，需要逐个走查调整：

### 5.1 触控区（最关键）

`src/ui/MobileControls.js` 第 30-31 行：

```css
.mc-left  { left:0; width:44vw; height:calc(var(--app-vh,100vh) * 0.42); min-height:200px }
.mc-right { right:0; top:0; width:50vw; height:var(--app-vh,100vh) }
```

- 横屏 780px 宽时：左侧移动区 `44vw = 343px`、右侧视角区 `50vw = 390px`，**两区之间只剩 47px 空隙** —— 这 47px 是**盲区**（既不能移动也不能转视角）。
- `44vw` / `0.42vh` 是**竖屏比例**。横屏下比例应该按**短边（高度）**算，而不是宽度。
- 建议加横屏分支，改成"左半屏移动、右半屏视角"的通用手游布局：

```css
@media (orientation: landscape) {
  .mc-left  { width:42vh; height:100%; min-height:0 }
  .mc-right { width:52vh; height:100% }
}
```

### 5.2 摇杆与按键的安全区

`MobileControls.js` 第 33、41 行：

```css
.mc-joy  { position:absolute; left:20px; bottom:26px; ... }
.mc-jump { position:fixed; right:20px; bottom:calc(env(safe-area-inset-bottom,0px) + 24px); ... }
```

- 横屏时**刘海/圆角在左右两侧**，所以竖屏用的 `safe-area-inset-bottom` 不够用了，**必须补 `env(safe-area-inset-left)` / `env(safe-area-inset-right)`**，否则摇杆和跳跃键会被刘海或圆角切掉。
- `index.html` 的 viewport 已有 `viewport-fit=cover` ✅，所以 `env()` 是有效的。

### 5.3 顶部一排（校卡 + 按钮行）

- `src/ui/PlayerHUD.js` 的 `@media (pointer: coarse)`：校卡 `left:12px; top:12px; width:156px`。
- `src/core/Game.js` 的 `_createTopButtons()`：按钮行 `left:172px; right:8px; top:12px`（**写死 px**，因为要和校卡宽度对齐）。
- 横屏 780px 宽时空间充裕，这排不用挪；但 `top` 要加 `env(safe-area-inset-top)`（横屏刘海同样在顶部有侵占可能）。
- **这两个数是一对**（`12 + 校卡宽 + 4 = 按钮行 left`），已有 `ui-check.mjs` 的算术对拍钉着，改一个必须改另一个。

### 5.4 布局系统的默认锚点

好消息：`src/ui/layout.js` **本来就横竖屏各存一套**（`portrait` / `landscape`），旋转适配机制不用重写。

但要注意 `applyLayout()` 的逻辑：**用户没拖动过的控件会 `restoreDefault()` 回到 CSS 默认锚点**。也就是说：

> **新用户第一次横屏进来，看到的就是上面那些"为竖屏写的 CSS 默认值"。**

所以第五节 5.1–5.3 改的就是**CSS 默认值本身**，不是存储数据。

### 5.5 弹窗类

- 设置弹窗：`width:min(280px, calc(100vw - 24px))`，横屏下 280px 在 780px 里偏窄，可放宽到 `min(420px, 60vw)`。
- 结算面板（上一轮新加的）、聊天框、商店面板同理。
- **横屏软键盘**（见第六节第 4 条）。

---

## 六、App 化必须补的 5 件事（不只是横屏）

| # | 事项 | 为什么必须做 | 怎么做 |
| --- | --- | --- | --- |
| 1 | **Android 返回键** | App 里按返回键默认**直接退出应用**，玩家会当场懵 | 用 `@capacitor/app` 监听 `backButton`：有面板开着就关面板，否则才退出 |
| 2 | **WebGL 上下文丢失** | 切后台、旋转、系统内存紧张时 WebView 会丢 context → 画面全黑/卡死 | 监听 `canvas.addEventListener('webglcontextlost')`，提示并重建渲染器 |
| 3 | **沉浸式全屏 + 刘海** | 有状态栏/导航栏就不是"游戏"了；横屏刘海在侧边 | `@capacitor/status-bar` 隐藏状态栏；清单里配 `windowLayoutInDisplayCutoutMode`；CSS 补左右安全区 |
| 4 | **横屏软键盘** | 横屏时键盘会吃掉**大半个屏幕**，聊天框会被顶飞或遮住输入框 | 项目已用 `visualViewport` 处理键盘 ✅（`ChatBox.js`），但仍需横屏真机验证；清单保持 `windowSoftInputMode="adjustResize"` |
| 5 | **老安卓 WebView 内核** | 项目用了 `color-mix()`（需 Chrome 111+）、`visualViewport` 等新 API | 把 `minSdk` 从 24 提到 **26 或 30**，避开内核过旧的老设备；或在 `theme.js` 里给 `color-mix` 写降级色 |

---

## 七、选"加载线上网址"必须接受的 4 个代价

**Capacitor 官方文档把 `server.url` 明确标注为 "This is not intended for use in production"**，原因就是下面这些：

1. **断网 = 白屏**。App 本身不含任何页面，所有资源每次从网上拉。没网、GitHub Pages 抽风、DNS 挂掉，统统进不去游戏。
2. **应用商店审核风险高**。纯在线壳 = "网页套壳"，Apple 的 Guideline 4.2（Minimum Functionality）和 Google Play 的 Spam/Webview 政策都可能直接拒。**自用或小范围发 APK 没问题，上架要走第八节的升级路径。**
3. **首屏慢**。冷启动要下载全部 JS/CSS/模型（bundle 约 1.86 MB + `public/` 里的 glb/fbx 模型），比内置资源慢一个量级。
4. **弱网体验差**。地铁、电梯里点开就是转圈。

**另外一条重要提醒**：Android WebView 的存储和手机 Chrome 浏览器**是分开的两个分区**。也就是说：

- App 里首次打开时，`localStorage` 是空的 → **要重新登录一次**账号（`fp_token` 不存在，会弹登录面板）。
- 纯本地数据 —— 布局位置（`fp_mobile_layout_v3`）、画面设置（`scene-settings-game-v1`）、本机训练场最高记录、城市建筑（`city.buildings.v1`）—— **不会从网页版带过来**。
- 但**账号数据（昵称/皮肤/称号/背包）是服务端的**（`/api/login` + WS `auth`），重新登录就全回来了 ✅。

---

## 八、升级路径（将来真要上架时）

按投入从低到高：

1. **现在**：`server.url` 在线模式 → 自用 / 发 APK 给朋友。
2. **要离线可用**：改成内置资源模式 —— `capacitor.config.json` 去掉 `server.url`，`webDir` 指向 `dist`，然后 `npm run build && npx cap sync android`。代价：**每次改网站都要重新打包发版**。
   - 这种模式下页面 origin 变成 `https://localhost`。好消息是服务端 CORS 是 `Access-Control-Allow-Origin: *`（通配），所以 `/api/login` **不会挂** ✅；但本地存档会从头开始。
3. **要"离线 + 网站改完自动更新"**：内置资源 + **Service Worker** 增量更新。首屏走本地（秒开、离线可用），SW 在后台从线上拉新版本缓存。**目前项目没有任何 SW，这是需要新增的一块。**
4. **要上架**：在第 3 步基础上补隐私政策页、应用图标全套、商店截图，iOS 还要借台 Mac。

---

## 九、如果现在就想看横屏效果（零成本，不必打包）

**手机浏览器横屏打开网站**就能看到横屏布局 —— 因为 `layout.js` 本来就支持双方向。

建议顺序：

1. 拿手机横屏打开 `https://graduate.dpdns.org`，把第五节列的 5 个点逐个走查一遍，**先确认"横屏到底能不能用"**。
2. 如果烂得比较多，先在**网页端**把横屏布局修好（改 CSS 默认值即可），这时打包只是"加个壳"，风险最低。
3. 再开打包。

也可以让我用现成的无头浏览器自检（`ui-browser-check.mjs` 已有 CDP + 设备模拟的底座），加一个 **780×360 横屏 Case** 来自动跑第 1 步，不用你手动试。

---

## 十、需要你确认的

| 项 | 我的建议 | 你的决定 |
| --- | --- | --- |
| 横屏方向值 | `sensorLandscape`（左右都能横） | ? |
| 是否先修横屏 UI 再打包 | **先修** —— 否则装到手机上大概率没法玩 | ? |
| `minSdk` | 26（Android 8） | ? |
| appId | `org.dpdns.graduate.fpm` | ? |
| 应用名 | 第一人称移动 | ? |
| 沉浸式全屏（隐藏状态栏/导航栏） | 要 | ? |
| 返回键行为 | 优先关面板，无面板才退出 | ? |

---

## 附：本方案涉及的文件

| 文件 | 作用 |
| --- | --- |
| `capacitor.config.json` | 新增，Capacitor 配置（appId / server.url / 插件） |
| `android/app/src/main/AndroidManifest.xml` | 新增（生成），**改这里锁横屏** |
| `android/app/build.gradle` | 新增（生成），签名 / minSdk |
| `src/ui/MobileControls.js` | **要改**，横屏触控区比例 + 左右安全区 |
| `src/ui/PlayerHUD.js` | **要改**，校卡横屏安全区 |
| `src/core/Game.js` | **要改**，顶部按钮行、返回键接管、WebGL 丢上下文兜底 |
| `src/ui/SettingsPanel.js` | 可能要改，弹窗宽度 |
| `src/ui/layout.js` | 不用改（已支持双方向） |
| 服务端 `server-remote/` | **不用改**（已是 wss + CORS 通配） |

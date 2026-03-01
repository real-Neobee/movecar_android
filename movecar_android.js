addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

const CONFIG = { KV_TTL: 3600 };

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/notify" && request.method === "POST") {
    return handleNotify(request, url);
  }

  if (path === "/api/get-location") {
    return handleGetLocation();
  }

  if (path === "/api/owner-confirm" && request.method === "POST") {
    return handleOwnerConfirmAction(request);
  }

  if (path === "/api/check-status") {
    const status = await MOVE_CAR_STATUS.get("notify_status");
    const ownerLocation = await MOVE_CAR_STATUS.get("owner_location");
    return new Response(
      JSON.stringify({
        status: status || "waiting",
        ownerLocation: ownerLocation ? JSON.parse(ownerLocation) : null,
      }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  if (path === "/owner-confirm") {
    return renderOwnerPage();
  }

  return renderMainPage(url.origin);
}

// ── 坐标转换：WGS-84 → GCJ-02（国测局坐标系，高德/腾讯地图使用）──────────────

function wgs84ToGcj02(lat, lng) {
  const a = 6378245.0;
  const ee = 0.00669342162296594323;
  if (outOfChina(lat, lng)) return { lat, lng };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret =
    -100.0 +
    2.0 * x +
    3.0 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));
  ret +=
    ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) *
      2.0) /
    3.0;
  ret +=
    ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) *
      2.0) /
    3.0;
  ret +=
    ((160.0 * Math.sin((y / 12.0) * Math.PI) +
      320 * Math.sin((y * Math.PI) / 30.0)) *
      2.0) /
    3.0;
  return ret;
}

function transformLng(x, y) {
  let ret =
    300.0 +
    x +
    2.0 * y +
    0.1 * x * x +
    0.1 * x * y +
    0.1 * Math.sqrt(Math.abs(x));
  ret +=
    ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) *
      2.0) /
    3.0;
  ret +=
    ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) *
      2.0) /
    3.0;
  ret +=
    ((150.0 * Math.sin((x / 12.0) * Math.PI) +
      300.0 * Math.sin((x / 30.0) * Math.PI)) *
      2.0) /
    3.0;
  return ret;
}

// 生成高德 / Apple Maps 跳转链接
function generateMapUrls(lat, lng) {
  const gcj = wgs84ToGcj02(lat, lng);
  return {
    amapUrl: `https://uri.amap.com/marker?position=${gcj.lng},${gcj.lat}&name=位置`,
    appleUrl: `https://maps.apple.com/?ll=${gcj.lat},${gcj.lng}&q=位置`,
  };
}

// ── 核心：处理挪车通知请求 ────────────────────────────────────────────────────

async function handleNotify(request, url) {
  try {
    const body = await request.json();
    const message = body.message || "车旁有人等待";
    const location = body.location || null;
    const delayed = body.delayed || false;

    // 车主确认页面链接，拼入 Server酱 推送正文
    const confirmUrl = encodeURIComponent(url.origin + "/owner-confirm");

    let notifyBody = "🚗 挪车请求";
    if (message) notifyBody += `\n💬 留言: ${message}`;

    if (location && location.lat && location.lng) {
      const urls = generateMapUrls(location.lat, location.lng);
      notifyBody += "\n📍 已附带位置信息，点击查看";
      // 将请求者位置写入 KV，供车主确认页读取
      await MOVE_CAR_STATUS.put(
        "requester_location",
        JSON.stringify({
          lat: location.lat,
          lng: location.lng,
          ...urls,
        }),
        { expirationTtl: CONFIG.KV_TTL },
      );
    } else {
      notifyBody += "\n⚠️ 未提供位置信息";
    }

    // 标记当前状态为"等待中"，TTL 10 分钟
    await MOVE_CAR_STATUS.put("notify_status", "waiting", {
      expirationTtl: 600,
    });

    // 无位置时延迟5分钟发送，降低恶意骚扰动力
    if (delayed) {
      await new Promise((resolve) => setTimeout(resolve, 300000));
    }

    // Server酱推送：desp 支持 Markdown，链接在微信内可点击跳转
    const confirmLink = `\n\n[👉 点击确认挪车](${decodeURIComponent(confirmUrl)})`;
    const scResponse = await fetch(`https://sctapi.ftqq.com/${SC_KEY}.send`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `title=${encodeURIComponent("🚗 挪车请求")}&desp=${encodeURIComponent(notifyBody + confirmLink)}`,
    });
    if (!scResponse.ok) throw new Error("Server酱 API Error");

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 500 },
    );
  }
}

// ── 获取请求者位置（供车主确认页展示地图）────────────────────────────────────

async function handleGetLocation() {
  const data = await MOVE_CAR_STATUS.get("requester_location");
  if (data) {
    return new Response(data, {
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ error: "No location" }), {
    status: 404,
  });
}

// ── 车主点击"已知晓"后的确认处理 ─────────────────────────────────────────────

async function handleOwnerConfirmAction(request) {
  try {
    const body = await request.json();
    const ownerLocation = body.location || null;

    if (ownerLocation) {
      const urls = generateMapUrls(ownerLocation.lat, ownerLocation.lng);
      // 将车主位置写入 KV，供请求者轮询后展示
      await MOVE_CAR_STATUS.put(
        "owner_location",
        JSON.stringify({
          lat: ownerLocation.lat,
          lng: ownerLocation.lng,
          ...urls,
          timestamp: Date.now(),
        }),
        { expirationTtl: CONFIG.KV_TTL },
      );
    }

    await MOVE_CAR_STATUS.put("notify_status", "confirmed", {
      expirationTtl: 600,
    });
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    // 即使出错也标记为已确认，保证流程不卡死
    await MOVE_CAR_STATUS.put("notify_status", "confirmed", {
      expirationTtl: 600,
    });
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ── 请求者主页面 ──────────────────────────────────────────────────────────────

function renderMainPage(origin) {
  const phone = typeof PHONE_NUMBER !== "undefined" ? PHONE_NUMBER : "";

  const html = /*html*/ `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, viewport-fit=cover">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="theme-color" content="#0093E9">
    <title>通知车主挪车</title>
    <style>
      :root { --sat: env(safe-area-inset-top, 0px); --sar: env(safe-area-inset-right, 0px); --sab: env(safe-area-inset-bottom, 0px); --sal: env(safe-area-inset-left, 0px); }
      * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; margin: 0; padding: 0; }
      html { font-size: 16px; -webkit-text-size-adjust: 100%; }
      html, body { height: 100%; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif;
        background: linear-gradient(160deg, #0093E9 0%, #80D0C7 100%);
        min-height: 100vh; min-height: -webkit-fill-available;
        padding: clamp(16px, 4vw, 24px);
        padding-top: calc(clamp(16px, 4vw, 24px) + var(--sat));
        padding-bottom: calc(clamp(16px, 4vw, 24px) + var(--sab));
        padding-left: calc(clamp(16px, 4vw, 24px) + var(--sal));
        padding-right: calc(clamp(16px, 4vw, 24px) + var(--sar));
        display: flex; justify-content: center; align-items: flex-start;
      }
      body::before {
        content: ''; position: fixed; inset: 0;
        background: url("data:image/svg+xml,%3Csvg width='52' height='26' viewBox='0 0 52 26' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.1'%3E%3Cpath d='M10 10c0-2.21-1.79-4-4-4-3.314 0-6-2.686-6-6h2c0 2.21 1.79 4 4 4 3.314 0 6 2.686 6 6 0 2.21 1.79 4 4 4 3.314 0 6 2.686 6 6 0 2.21 1.79 4 4 4v2c-3.314 0-6-2.686-6-6 0-2.21-1.79-4-4-4-3.314 0-6-2.686-6-6zm25.464-1.95l8.486 8.486-1.414 1.414-8.486-8.486 1.414-1.414z' /%3E%3C/g%3E%3C/g%3E%3C/svg%3E");
        z-index: -1;
      }
      .container { width: 100%; max-width: 500px; display: flex; flex-direction: column; gap: clamp(12px, 3vw, 20px); }
      .card { background: rgba(255, 255, 255, 0.95); border-radius: clamp(20px, 5vw, 28px); padding: clamp(18px, 4vw, 28px); box-shadow: 0 10px 40px rgba(0, 147, 233, 0.2); transition: transform 0.2s ease; }
      @media (hover: hover) { .card:hover { transform: translateY(-2px); } }
      .card:active { transform: scale(0.98); }
      .header { text-align: center; padding: clamp(20px, 5vw, 32px) clamp(16px, 4vw, 28px); background: white; }
      .icon-wrap { width: clamp(72px, 18vw, 100px); height: clamp(72px, 18vw, 100px); background: linear-gradient(135deg, #0093E9 0%, #80D0C7 100%); border-radius: clamp(22px, 5vw, 32px); display: flex; align-items: center; justify-content: center; margin: 0 auto clamp(14px, 3vw, 24px); box-shadow: 0 12px 32px rgba(0, 147, 233, 0.35); }
      .icon-wrap span { font-size: clamp(36px, 9vw, 52px); line-height: 1; display: block; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
      .header h1 { font-size: clamp(22px, 5.5vw, 30px); font-weight: 700; color: #1a202c; margin-bottom: 6px; }
      .header p { font-size: clamp(13px, 3.5vw, 16px); color: #718096; font-weight: 500; }
      .input-card { padding: 0; overflow: hidden; }
      .input-card .msg-input { width: 100%; min-height: clamp(90px, 20vw, 120px); border: none; padding: clamp(16px, 4vw, 24px); font-size: clamp(15px, 4vw, 18px); font-family: inherit; outline: none; color: #2d3748; background: transparent; line-height: 1.5; cursor: text; }
      .input-card .msg-input:empty::before { content: attr(data-placeholder); color: #a0aec0; pointer-events: none; }
      .tags { display: flex; justify-content: center; gap: clamp(8px, 3vw, 16px); padding: 0 clamp(12px, 3vw, 20px) clamp(14px, 3vw, 20px); flex-wrap: wrap; }
      .tag { background: linear-gradient(135deg, #e0f7fa 0%, #b2ebf2 100%); color: #00796b; padding: clamp(8px, 2vw, 12px) clamp(12px, 3vw, 18px); border-radius: 20px; font-size: clamp(13px, 3.5vw, 15px); font-weight: 600; white-space: nowrap; cursor: pointer; transition: all 0.2s; border: 1px solid #80cbc4; min-height: 44px; display: flex; align-items: center; }
      .tag:active { transform: scale(0.95); background: #80cbc4; }
      /* 标签选中高亮状态 */
      .tag.active { background: linear-gradient(135deg, #b2dfdb 0%, #80cbc4 100%); border-color: #00897b; color: #00695c; }
      .loc-card { display: flex; align-items: center; gap: clamp(10px, 3vw, 16px); padding: clamp(14px, 3.5vw, 22px) clamp(16px, 4vw, 24px); cursor: pointer; min-height: 64px; }
      .loc-icon { width: clamp(44px, 11vw, 56px); height: clamp(44px, 11vw, 56px); border-radius: clamp(14px, 3.5vw, 18px); display: flex; align-items: center; justify-content: center; font-size: clamp(22px, 5.5vw, 28px); transition: all 0.3s; flex-shrink: 0; }
      .loc-icon.loading { background: #fff3cd; }
      .loc-icon.success { background: #d4edda; }
      .loc-icon.error { background: #f8d7da; }
      .loc-content { flex: 1; min-width: 0; }
      .loc-title { font-size: clamp(15px, 4vw, 18px); font-weight: 600; color: #2d3748; }
      .loc-status { font-size: clamp(12px, 3.2vw, 14px); color: #718096; margin-top: 3px; }
      .loc-status.success { color: #28a745; }
      .loc-status.error { color: #dc3545; }
      .btn-main { background: linear-gradient(135deg, #0093E9 0%, #80D0C7 100%); color: white; border: none; padding: clamp(16px, 4vw, 22px); border-radius: clamp(16px, 4vw, 22px); font-size: clamp(16px, 4.2vw, 20px); font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; box-shadow: 0 10px 30px rgba(0, 147, 233, 0.35); transition: all 0.2s; min-height: 56px; }
      .btn-main:active { transform: scale(0.98); }
      .btn-main:disabled { background: linear-gradient(135deg, #94a3b8 0%, #64748b 100%); box-shadow: none; cursor: not-allowed; }
      .toast { position: fixed; top: calc(20px + var(--sat)); left: 50%; transform: translateX(-50%) translateY(-100px); background: white; padding: clamp(12px, 3vw, 16px) clamp(20px, 5vw, 32px); border-radius: 16px; font-size: clamp(14px, 3.5vw, 16px); font-weight: 600; color: #2d3748; box-shadow: 0 10px 40px rgba(0,0,0,0.15); opacity: 0; transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275); z-index: 100; max-width: calc(100vw - 40px); }
      .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
      #successView { display: none; }
      .success-card { text-align: center; background: linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%); border: 2px solid #28a745; }
      .success-icon { font-size: clamp(56px, 14vw, 80px); margin-bottom: clamp(12px, 3vw, 20px); display: block; }
      .success-card h2 { color: #155724; margin-bottom: 8px; font-size: clamp(20px, 5vw, 28px); }
      .success-card p { color: #1e7e34; font-size: clamp(14px, 3.5vw, 16px); }
      .owner-card { background: white; border: 2px solid #80D0C7; text-align: center; }
      .owner-card.hidden { display: none; }
      .owner-card h3 { color: #0093E9; margin-bottom: 8px; font-size: clamp(18px, 4.5vw, 22px); }
      .owner-card p { color: #718096; margin-bottom: 16px; font-size: clamp(14px, 3.5vw, 16px); }
      .owner-card .map-links { display: flex; gap: clamp(8px, 2vw, 14px); flex-wrap: wrap; }
      .owner-card .map-btn { flex: 1; min-width: 120px; padding: clamp(12px, 3vw, 16px); border-radius: clamp(12px, 3vw, 16px); text-decoration: none; font-weight: 600; font-size: clamp(13px, 3.5vw, 15px); text-align: center; min-height: 48px; display: flex; align-items: center; justify-content: center; }
      .map-btn.amap { background: #1890ff; color: white; }
      .map-btn.apple { background: #1d1d1f; color: white; }
      .action-card { display: flex; flex-direction: column; gap: clamp(10px, 2.5vw, 14px); }
      .action-hint { text-align: center; font-size: clamp(13px, 3.5vw, 15px); color: #718096; margin-bottom: 4px; }
      .btn-retry, .btn-phone { color: white; border: none; padding: clamp(14px, 3.5vw, 18px); border-radius: clamp(14px, 3.5vw, 18px); font-size: clamp(15px, 4vw, 17px); font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; transition: all 0.2s; min-height: 52px; text-decoration: none; }
      .btn-retry { background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); box-shadow: 0 8px 24px rgba(245, 158, 11, 0.3); }
      .btn-retry:active { transform: scale(0.98); }
      .btn-retry:disabled { background: linear-gradient(135deg, #9ca3af 0%, #6b7280 100%); box-shadow: none; cursor: not-allowed; }
      .btn-phone { background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); box-shadow: 0 8px 24px rgba(239, 68, 68, 0.3); }
      .btn-phone:active { transform: scale(0.98); }
      @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      .loading-text { animation: pulse 1.5s ease-in-out infinite; }
      .modal-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; z-index: 200; padding: 20px; opacity: 0; visibility: hidden; transition: all 0.3s; }
      .modal-overlay.show { opacity: 1; visibility: visible; }
      .modal-box { background: white; border-radius: 20px; padding: clamp(24px, 6vw, 32px); max-width: 340px; width: 100%; text-align: center; transform: scale(0.9); transition: transform 0.3s; }
      .modal-overlay.show .modal-box { transform: scale(1); }
      .modal-icon { font-size: 48px; margin-bottom: 16px; }
      .modal-title { font-size: 18px; font-weight: 700; color: #1a202c; margin-bottom: 8px; }
      .modal-desc { font-size: 14px; color: #718096; margin-bottom: 24px; line-height: 1.5; }
      .modal-buttons { display: flex; gap: 12px; }
      .modal-btn { flex: 1; padding: 14px 16px; border-radius: 12px; font-size: 15px; font-weight: 600; cursor: pointer; border: none; transition: all 0.2s; }
      .modal-btn:active { transform: scale(0.96); }
      .modal-btn-primary { background: linear-gradient(135deg, #0093E9 0%, #80D0C7 100%); color: white; }
      .modal-btn-secondary { background: #f1f5f9; color: #64748b; }
      @media (min-width: 768px) { body { align-items: center; } .container { max-width: 480px; } }
      @media (min-width: 1024px) { .container { max-width: 520px; } .card { padding: 32px; } }
      @media (min-width: 600px) and (max-width: 900px) { .container { max-width: 460px; } }
      @media (orientation: landscape) and (max-height: 500px) { body { align-items: flex-start; padding-top: calc(12px + var(--sat)); } .header { padding: 16px; } .icon-wrap { width: 60px; height: 60px; margin-bottom: 12px; } .icon-wrap span { font-size: 32px; line-height: 1; display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; } .success-icon { font-size: 48px; margin-bottom: 10px; } }
      @media (max-width: 350px) { .container { gap: 10px; } .card { padding: 14px; border-radius: 18px; } .tags { gap: 6px; } .tag { padding: 8px 10px; font-size: 12px; } }
    </style>
  </head>
  <body>
    <div id="toast" class="toast"></div>

    <!-- 位置授权提示弹窗：页面加载后自动弹出 -->
    <div id="locationTipModal" class="modal-overlay">
      <div class="modal-box">
        <div class="modal-icon">📍</div>
        <div class="modal-title">位置信息说明</div>
        <div class="modal-desc">分享位置可让车主确认您在车旁<br>不分享将延迟5分钟发送通知</div>
        <div class="modal-buttons">
          <button class="modal-btn modal-btn-primary" onclick="hideModal('locationTipModal');requestLocation()">我知道了</button>
        </div>
      </div>
    </div>

    <div class="container" id="mainView">
      <div class="card header">
        <div class="icon-wrap"><span>🚗</span></div>
        <h1>通知车主挪车</h1>
        <p>Notify Car Owner</p>
      </div>

      <div class="card input-card">
        <!-- contenteditable 输入框：支持富文本（加急红色文字）-->
        <div id="msgInput" class="msg-input" contenteditable="true" data-placeholder="输入留言给车主...（或点击下方按钮）"></div>

        <div class="tags">
          <!-- [修改] 恢复 id 属性，供 updateTagActive() 控制高亮；挡路/临停互斥 -->
          <div id="tag-block" class="tag" onclick="selectBase('您的车挡住我了')">🚧 挡路</div>
          <div id="tag-temp"  class="tag" onclick="selectBase('临时停靠一下')">⏱️ 临停</div>
          <div id="tag-urgent" class="tag" onclick="toggleUrgent()">🙏 加急</div>
        </div>
      </div>

      <div class="card loc-card">
        <div id="locIcon" class="loc-icon loading">📍</div>
        <div class="loc-content">
          <div class="loc-title">我的位置</div>
          <div id="locStatus" class="loc-status">等待获取...</div>
        </div>
      </div>

      <button id="notifyBtn" class="card btn-main" onclick="sendNotify()">
        <span>🔔</span>
        <span>一键通知车主</span>
      </button>
    </div>

    <div class="container" id="successView">
      <div class="card success-card">
        <span class="success-icon">✅</span>
        <h2>通知已发送！</h2>
        <p id="waitingText" class="loading-text">正在等待车主回应...</p>
      </div>

      <div id="ownerFeedback" class="card owner-card hidden">
        <span style="font-size:56px; display:block; margin-bottom:16px">🎉</span>
        <h3>车主已收到通知</h3>
        <p>正在赶来，点击查看车主位置</p>
        <div id="ownerMapLinks" class="map-links" style="display:none">
          <a id="ownerAmapLink" href="#" class="map-btn amap">🗺️ 高德地图</a>
          <a id="ownerAppleLink" href="#" class="map-btn apple">🍎 Apple Maps</a>
        </div>
      </div>

      <div class="card action-card">
        <p class="action-hint">车主没反应？试试其他方式</p>
        <button id="retryBtn" class="btn-retry" onclick="retryNotify()">
          <span>🔔</span>
          <span>再次通知</span>
        </button>
        <a href="tel:${phone}" class="btn-phone">
          <span>📞</span>
          <span>直接拨号</span>
        </a>
      </div>
    </div>

    <script>
      let userLocation = null;
      let checkTimer = null;

      // ── 页面初始化 ──────────────────────────────────────────────────────────

      window.onload = () => {
        showModal('locationTipModal');
      };

      function showModal(id) { document.getElementById(id).classList.add('show'); }
      function hideModal(id) { document.getElementById(id).classList.remove('show'); }

      // ── 位置获取 ────────────────────────────────────────────────────────────

      function requestLocation() {
        const icon = document.getElementById('locIcon');
        const txt  = document.getElementById('locStatus');
        icon.className = 'loc-icon loading';
        txt.className  = 'loc-status';
        txt.innerText  = '正在获取定位...';

        if ('geolocation' in navigator) {
          navigator.geolocation.getCurrentPosition(
            pos => {
              userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
              icon.className = 'loc-icon success';
              txt.className  = 'loc-status success';
              txt.innerText  = '已获取位置 ✓';
            },
            () => {
              icon.className = 'loc-icon error';
              txt.className  = 'loc-status error';
              txt.innerText  = '位置获取失败，刷新页面重试或复制链接到浏览器打开';
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
          );
        } else {
          icon.className = 'loc-icon error';
          txt.className  = 'loc-status error';
          txt.innerText  = '浏览器不支持定位';
        }
      }

      // ── 标签状态管理 ────────────────────────────────────────────────────────
      // [修改] 以下为重写的标签逻辑，解决四个问题：
      //   1. 挡路 / 临停 互斥（切换时自动移除另一个）
      //   2. 再次点击同一标签可取消
      //   3. 加急防重复插入（再次点击为取消）
      //   4. 恢复标签选中高亮反馈

      let selectedBaseText = ''; // 当前选中的基础标签文本，'' 表示未选
      let urgentInserted   = false; // 加急是否已插入

      // 选择/取消 挡路 or 临停（二选一，互斥）
      function selectBase(text) {
        const el = document.getElementById('msgInput');

        if (selectedBaseText === text) {
          // 再次点击：取消，从编辑框移除该文本
          removeBaseText(el, text);
          selectedBaseText = '';
        } else {
          if (selectedBaseText) {
            // 已选另一个：先替换掉旧文本，再更新为新文本
            replaceBaseText(el, selectedBaseText, text);
          } else {
            // 尚未选任何基础标签：在光标处插入
            insertAtCursor(el, text);
          }
          selectedBaseText = text;
        }
        updateTagActive();
      }

      // 插入 / 取消 加急（toggle，始终追加到末尾，红色加粗）
      function toggleUrgent() {
        const el = document.getElementById('msgInput');
        const existing = el.querySelector('span[data-urgent]');

        if (existing) {
          // 已存在：移除
          existing.remove();
          urgentInserted = false;
        } else {
          // 不存在：追加到末尾
          const currentText = el.innerText.trim();
          const u = document.createElement('span');
          u.dataset.urgent    = '1';                              // 标记用于后续查找
          u.style.color       = '#e53e3e';
          u.style.fontWeight  = '700';
          u.textContent = (currentText && !currentText.endsWith('，') ? '，' : '') + '麻烦尽快';
          el.appendChild(u);
          moveCursorToEnd(el);
          urgentInserted = true;
        }
        updateTagActive();
      }

      function insertAtCursor(el, text) {
        el.focus();
        const sel = window.getSelection();
        const urgentEl = el.querySelector('span[data-urgent]');

  // 光标存在 且 不在加急 span 内部时，才在光标处插入
        if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)
            && !(urgentEl && urgentEl.contains(sel.anchorNode))) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          const node = document.createTextNode(text);
          range.insertNode(node);
          range.setStartAfter(node);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        } else {
          // 光标在加急 span 内或不存在时，统一插到加急 span 之前
          el.insertBefore(document.createTextNode(text), urgentEl || null);
        }
      }

      // 从编辑框中移除指定的基础文本（跳过加急 span 内部的文本节点）
      function removeBaseText(el, text) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const n = walker.currentNode;
          if (n.parentNode && n.parentNode.dataset && n.parentNode.dataset.urgent) continue;
          if (n.textContent.includes(text)) {
            n.textContent = n.textContent.replace(text, '');
            break;
          }
        }
      }

      // 将编辑框中的旧基础文本替换为新文本（找不到则直接插入光标处）
      function replaceBaseText(el, oldText, newText) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const n = walker.currentNode;
          if (n.parentNode && n.parentNode.dataset && n.parentNode.dataset.urgent) continue;
          if (n.textContent.includes(oldText)) {
            n.textContent = n.textContent.replace(oldText, newText);
            return;
          }
        }
        // 旧文本已被手动删除，直接在光标处插入新文本
        insertAtCursor(el, newText);
      }

      // 同步三个标签的选中高亮状态
      function updateTagActive() {
        document.getElementById('tag-block').classList.toggle('active', selectedBaseText === '您的车挡住我了');
        document.getElementById('tag-temp').classList.toggle('active',  selectedBaseText === '临时停靠一下');
        document.getElementById('tag-urgent').classList.toggle('active', urgentInserted);
      }

      // 将光标移至编辑框末尾
      function moveCursorToEnd(el) {
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false); // false = 折叠到末尾
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }

      // ── 发送通知 ────────────────────────────────────────────────────────────

      async function sendNotify() {
        const btn     = document.getElementById('notifyBtn');
        const msg     = document.getElementById('msgInput').innerText.trim();
        const delayed = !userLocation; // 无位置则延迟 5 分钟

        btn.disabled  = true;
        btn.innerHTML = '<span>🚀</span><span>发送中...</span>';

        try {
          const res = await fetch('/api/notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg, location: userLocation, delayed })
          });

          if (res.ok) {
            showToast(delayed ? '⏳ 通知将延迟 5 分钟发送' : '✅ 发送成功！');
            document.getElementById('mainView').style.display    = 'none';
            document.getElementById('successView').style.display = 'flex';
            startPolling();
          } else {
            throw new Error('API Error');
          }
        } catch (e) {
          showToast('❌ 发送失败，请重试');
          btn.disabled  = false;
          btn.innerHTML = '<span>🔔</span><span>一键通知车主</span>';
        }
      }

      // ── 轮询车主确认状态（每 3 秒，最多 6 分钟）──────────────────────────

      function startPolling() {
        let count = 0;
        checkTimer = setInterval(async () => {
          count++;
          if (count > 120) { clearInterval(checkTimer); return; }
          try {
            const res  = await fetch('/api/check-status');
            const data = await res.json();
            if (data.status === 'confirmed') {
              const fb = document.getElementById('ownerFeedback');
              fb.classList.remove('hidden');
              if (data.ownerLocation && data.ownerLocation.amapUrl) {
                document.getElementById('ownerMapLinks').style.display = 'flex';
                document.getElementById('ownerAmapLink').href = data.ownerLocation.amapUrl;
                document.getElementById('ownerAppleLink').href = data.ownerLocation.appleUrl;
              }
              clearInterval(checkTimer);
              if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
            }
          } catch(e) {}
        }, 3000);
      }

      // ── 再次通知 ────────────────────────────────────────────────────────────

      async function retryNotify() {
        const btn = document.getElementById('retryBtn');
        btn.disabled  = true;
        btn.innerHTML = '<span>🚀</span><span>发送中...</span>';

        try {
          const res = await fetch('/api/notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: '再次通知：请尽快挪车', location: userLocation })
          });

          if (res.ok) {
            showToast('✅ 再次通知已发送！');
            document.getElementById('waitingText').innerText = '已再次通知，等待车主回应...';
          } else {
            throw new Error('API Error');
          }
        } catch (e) {
          showToast('❌ 发送失败，请重试');
        }

        btn.disabled  = false;
        btn.innerHTML = '<span>🔔</span><span>再次通知</span>';
      }

      // ── 工具函数 ────────────────────────────────────────────────────────────

      function showToast(text) {
        const t = document.getElementById('toast');
        t.innerText = text;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 3000);
      }
    </script>
  </body>
  </html>
  `;
  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}

// ── 车主确认页面 ──────────────────────────────────────────────────

function renderOwnerPage() {
  const html = /*html*/ `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, viewport-fit=cover">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="theme-color" content="#667eea">
    <title>确认挪车</title>
    <style>
      :root { --sat: env(safe-area-inset-top, 0px); --sar: env(safe-area-inset-right, 0px); --sab: env(safe-area-inset-bottom, 0px); --sal: env(safe-area-inset-left, 0px); }
      * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
      html { font-size: 16px; -webkit-text-size-adjust: 100%; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif;
        background: linear-gradient(160deg, #667eea 0%, #764ba2 100%);
        min-height: 100vh; min-height: -webkit-fill-available;
        padding: clamp(16px, 4vw, 24px);
        padding-top: calc(clamp(16px, 4vw, 24px) + var(--sat));
        padding-bottom: calc(clamp(16px, 4vw, 24px) + var(--sab));
        padding-left: calc(clamp(16px, 4vw, 24px) + var(--sal));
        padding-right: calc(clamp(16px, 4vw, 24px) + var(--sar));
        display: flex; flex-direction: column; align-items: center; justify-content: center;
      }
      .card { background: rgba(255,255,255,0.95); padding: clamp(24px, 6vw, 36px); border-radius: clamp(24px, 6vw, 32px); text-align: center; width: 100%; max-width: 420px; box-shadow: 0 20px 60px rgba(102, 126, 234, 0.3); }
      .emoji { font-size: clamp(52px, 13vw, 72px); margin-bottom: clamp(16px, 4vw, 24px); display: block; }
      h1 { font-size: clamp(22px, 5.5vw, 28px); color: #2d3748; margin-bottom: 8px; }
      .subtitle { color: #718096; font-size: clamp(14px, 3.5vw, 16px); margin-bottom: clamp(20px, 5vw, 28px); }
      .map-section { background: linear-gradient(135deg, #eef2ff 0%, #e0e7ff 100%); border-radius: clamp(14px, 3.5vw, 18px); padding: clamp(14px, 3.5vw, 20px); margin-bottom: clamp(16px, 4vw, 24px); display: none; }
      .map-section.show { display: block; }
      .map-section p { font-size: clamp(12px, 3.2vw, 14px); color: #6366f1; margin-bottom: 12px; font-weight: 600; }
      .map-links { display: flex; gap: clamp(8px, 2vw, 12px); flex-wrap: wrap; }
      .map-btn { flex: 1; min-width: 110px; padding: clamp(12px, 3vw, 16px); border-radius: clamp(10px, 2.5vw, 14px); text-decoration: none; font-weight: 600; font-size: clamp(13px, 3.5vw, 15px); text-align: center; transition: transform 0.2s; min-height: 48px; display: flex; align-items: center; justify-content: center; }
      .map-btn:active { transform: scale(0.96); }
      .map-btn.amap { background: #1890ff; color: white; }
      .map-btn.apple { background: #1d1d1f; color: white; }
      .btn { background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border: none; width: 100%; padding: clamp(16px, 4vw, 20px); border-radius: clamp(14px, 3.5vw, 18px); font-size: clamp(16px, 4.2vw, 19px); font-weight: 700; cursor: pointer; box-shadow: 0 8px 24px rgba(16, 185, 129, 0.35); display: flex; align-items: center; justify-content: center; gap: 10px; transition: all 0.2s; min-height: 56px; }
      .btn:active { transform: scale(0.98); }
      .btn:disabled { background: linear-gradient(135deg, #9ca3af 0%, #6b7280 100%); box-shadow: none; cursor: not-allowed; }
      .done-msg { background: linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%); border-radius: clamp(14px, 3.5vw, 18px); padding: clamp(16px, 4vw, 24px); margin-top: clamp(16px, 4vw, 24px); display: none; }
      .done-msg.show { display: block; }
      .done-msg p { color: #065f46; font-weight: 600; font-size: clamp(15px, 4vw, 17px); }
      @media (min-width: 768px) { .card { max-width: 440px; padding: 40px; } }
      @media (orientation: landscape) and (max-height: 500px) { body { justify-content: flex-start; padding-top: calc(12px + var(--sat)); } .card { padding: 20px 28px; } .emoji { font-size: 44px; margin-bottom: 12px; } .subtitle { margin-bottom: 16px; } }
      @media (max-width: 350px) { .card { padding: 20px; border-radius: 20px; } .map-btn { min-width: 100px; padding: 10px; } }
    </style>
  </head>
  <body>
    <div class="card">
      <span class="emoji">👋</span>
      <h1>收到挪车请求</h1>
      <p class="subtitle">对方正在等待，请尽快确认</p>

      <div id="mapArea" class="map-section">
        <p>📍 对方位置</p>
        <div class="map-links">
          <a id="amapLink"  href="#" class="map-btn amap">🗺️ 高德地图</a>
          <a id="appleLink" href="#" class="map-btn apple">🍎 Apple Maps</a>
        </div>
      </div>

      <button id="confirmBtn" class="btn" onclick="confirmMove()">
        <span>🚀</span>
        <span>我已知晓，正在前往</span>
      </button>

      <div id="doneMsg" class="done-msg">
        <p>✅ 已通知对方您正在赶来！</p>
      </div>
    </div>

    <script>
      let ownerLocation = null;

      // 页面加载时读取请求者位置，有则展示地图链接
      window.onload = async () => {
        try {
          const res = await fetch('/api/get-location');
          if (res.ok) {
            const data = await res.json();
            if (data.amapUrl) {
              document.getElementById('mapArea').classList.add('show');
              document.getElementById('amapLink').href  = data.amapUrl;
              document.getElementById('appleLink').href = data.appleUrl;
            }
          }
        } catch(e) {}
      };

      // 点击确认：触发定位授权，无论是否授权都发送确认
      async function confirmMove() {
        const btn = document.getElementById('confirmBtn');
        btn.disabled  = true;
        btn.innerHTML = '<span>📍</span><span>获取位置中...</span>';

        if ('geolocation' in navigator) {
          navigator.geolocation.getCurrentPosition(
            async pos => {
              ownerLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
              await doConfirm();
            },
            async () => {
              ownerLocation = null;
              await doConfirm();
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
          );
        } else {
          ownerLocation = null;
          await doConfirm();
        }
      }

      // 发送确认请求（携带车主位置，位置可选）
      async function doConfirm() {
        const btn = document.getElementById('confirmBtn');
        btn.innerHTML = '<span>⏳</span><span>确认中...</span>';

        try {
          await fetch('/api/owner-confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ location: ownerLocation })
          });
          btn.innerHTML    = '<span>✅</span><span>已确认</span>';
          btn.style.background = 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)';
          document.getElementById('doneMsg').classList.add('show');
        } catch(e) {
          btn.disabled  = false;
          btn.innerHTML = '<span>🚀</span><span>我已知晓，正在前往</span>';
        }
      }
    </script>
  </body>
  </html>
  `;
  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}

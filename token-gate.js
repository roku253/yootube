/**
 * 外部サイト用 トークンゲート（NSID + masterToken 方式 / 高速化版）
 *
 * 性能設計：
 *  1) sessionStorage に「この resourceKey は最近 valid だった」フラグがあれば、即 unlock してネットワーク呼び出しゼロで終わる。
 *  2) localStorage に資格情報がある場合は、まず unlock して「楽観的に表示」し、
 *     バックグラウンドで /api/platform/validate-entitlement を叩く。失敗時のみ後追いでロック+denied。
 *  3) localStorage が空のときだけ、opener へ postMessage を投げて取得（最大 3 秒）。
 *
 * 設定：
 *  - TOKEN_GATE_ORIGIN: 任務ポータルのオリジン
 *  - <head> で window.__TOKEN_RESOURCE_KEY__ を設定（例: "ext:urban-legend-board"）
 *
 * 任意フック：
 *  - window.__TOKEN_DENIED__(message) でサイトの雰囲気に合った全面エラーを表示
 *    （未定義時はデフォルトの黒画面オーバーレイ）
 */
;(function () {
  var TOKEN_GATE_ORIGIN = "https://nazo-portal.vercel.app"
  var LS_LOGIN = "ns_login_id"
  var LS_MASTER = "ns_master_token"
  var LS_CASE = "ns_case_id"
  var MSG_REQUEST = "NS_AUTH_REQUEST"
  var MSG_GRANT = "NS_AUTH_GRANT"
  /** sessionStorage の「ここ最近検証OK」フラグ。タブを閉じれば消える */
  var SS_OK_PREFIX = "ns_gate_ok_v1_"
  /** OK フラグの有効期限。ここを過ぎると再度バックグラウンド検証する */
  var OK_TTL_MS = 5 * 60 * 1000

  function readCreds() {
    try {
      return {
        loginId: (localStorage.getItem(LS_LOGIN) || "").trim(),
        masterToken: (localStorage.getItem(LS_MASTER) || "").trim(),
        caseId: (localStorage.getItem(LS_CASE) || "").trim(),
      }
    } catch (e) {
      return { loginId: "", masterToken: "", caseId: "" }
    }
  }

  function writeCreds(c) {
    try {
      if (c.loginId) localStorage.setItem(LS_LOGIN, String(c.loginId))
      if (c.masterToken) localStorage.setItem(LS_MASTER, String(c.masterToken))
      if (c.caseId) localStorage.setItem(LS_CASE, String(c.caseId))
    } catch (e) {}
  }

  function clearCreds() {
    try {
      localStorage.removeItem(LS_LOGIN)
      localStorage.removeItem(LS_MASTER)
      localStorage.removeItem(LS_CASE)
    } catch (e) {}
  }

  function ssOkKey(resourceKey) {
    return SS_OK_PREFIX + (resourceKey || "")
  }

  function readCachedOk(resourceKey) {
    if (!resourceKey) return false
    try {
      var raw = sessionStorage.getItem(ssOkKey(resourceKey))
      if (!raw) return false
      var n = Number(raw)
      if (!n || isNaN(n)) return false
      if (Date.now() - n > OK_TTL_MS) {
        sessionStorage.removeItem(ssOkKey(resourceKey))
        return false
      }
      return true
    } catch (e) {
      return false
    }
  }

  function writeCachedOk(resourceKey) {
    if (!resourceKey) return
    try {
      sessionStorage.setItem(ssOkKey(resourceKey), String(Date.now()))
    } catch (e) {}
  }

  function clearCachedOk(resourceKey) {
    if (!resourceKey) return
    try {
      sessionStorage.removeItem(ssOkKey(resourceKey))
    } catch (e) {}
  }

  function cleanUrlToken() {
    try {
      var u = new URL(window.location.href)
      if (u.searchParams.has("token")) {
        u.searchParams.delete("token")
        window.history.replaceState({}, "", u.pathname + u.search + u.hash)
      }
    } catch (e) {}
  }

  function defaultDenied(msg) {
    var m = document.createElement("div")
    m.setAttribute(
      "style",
      "position:fixed;inset:0;z-index:999999;background:#0a0a0c;color:#e8e8ec;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,sans-serif;text-align:center;"
    )
    m.innerHTML =
      "<div><p style=\"font-size:14px;opacity:.85\">" +
      String(msg)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;") +
      "</p></div>"
    document.documentElement.appendChild(m)
  }

  function showDenied(msg) {
    try {
      if (typeof window.__TOKEN_DENIED__ === "function") {
        window.__TOKEN_DENIED__(msg)
        return
      }
    } catch (e) {}
    defaultDenied(msg)
  }

  function unlock() {
    document.documentElement.classList.add("token-gate-ok")
  }

  function lock() {
    document.documentElement.classList.remove("token-gate-ok")
  }

  function callValidate(c) {
    var resourceKey = window.__TOKEN_RESOURCE_KEY__ || ""
    return fetch(TOKEN_GATE_ORIGIN + "/api/platform/validate-entitlement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        loginId: c.loginId,
        masterToken: c.masterToken,
        caseId: c.caseId,
        resourceKey: resourceKey,
      }),
    }).then(function (r) {
      return r.json()
    })
  }

  /**
   * opener にだけ短時間でリクエストして資格情報を取得する。
   * 取れなければ resolve(null)。タイムアウトは合計 3 秒（旧版は 20 秒）。
   */
  function bootstrapFromOpener() {
    return new Promise(function (resolve) {
      if (!window.opener || window.opener.closed) {
        resolve(null)
        return
      }
      var finished = false
      var tries = 0
      var MAX_TRIES = 12 // 150ms × 12 = 1.8s
      var poll = setInterval(function () {
        if (finished) return
        tries++
        if (tries > MAX_TRIES) {
          clearInterval(poll)
          if (!finished) resolve(null)
          return
        }
        try {
          window.opener.postMessage(
            { type: MSG_REQUEST, resourceKey: window.__TOKEN_RESOURCE_KEY__ || "" },
            TOKEN_GATE_ORIGIN
          )
        } catch (e) {}
      }, 150)

      function onGrant(ev) {
        if (ev.origin !== TOKEN_GATE_ORIGIN) return
        if (!ev.data || ev.data.type !== MSG_GRANT) return
        finished = true
        clearInterval(poll)
        window.removeEventListener("message", onGrant)
        var c = {
          loginId: String(ev.data.loginId || "").trim(),
          masterToken: String(ev.data.masterToken || "").trim(),
          caseId: String(ev.data.caseId || "").trim(),
        }
        if (c.loginId && c.masterToken && c.caseId) {
          writeCreds(c)
          resolve(c)
        } else {
          resolve(null)
        }
      }
      window.addEventListener("message", onGrant)
    })
  }

  /**
   * すでに unlock 済みの状態でバックグラウンド検証する。
   * - valid: sessionStorage に OK フラグを更新するだけ
   * - invalid: ロックして denied を出す
   * - network error: 楽観表示を維持（次回ロード時に再検証されるので問題なし）
   */
  function backgroundRevalidate(c, resourceKey) {
    callValidate(c)
      .then(function (data) {
        if (data && data.valid === true) {
          writeCachedOk(resourceKey)
        } else {
          clearCachedOk(resourceKey)
          lock()
          showDenied((data && data.message) || "アクセス権限がありません。")
        }
      })
      .catch(function () {
        /* network error: 楽観表示のまま維持 */
      })
  }

  function start() {
    cleanUrlToken()
    var resourceKey = window.__TOKEN_RESOURCE_KEY__ || ""
    var c = readCreds()

    // ★ FAST PATH 1: 同じセッションで最近検証OKだった
    if (resourceKey && readCachedOk(resourceKey) && c.loginId && c.masterToken && c.caseId) {
      unlock()
      return
    }

    // ★ FAST PATH 2: localStorage に資格情報があれば楽観的に即表示
    if (c.loginId && c.masterToken && c.caseId) {
      unlock()
      backgroundRevalidate(c, resourceKey)
      return
    }

    // SLOW PATH: opener から受け取って検証
    bootstrapFromOpener().then(function (c2) {
      if (!c2) {
        showDenied(
          "このページを単独で開くには、先に任務ポータルにログインし、対象作品をプレイ開始してください。"
        )
        return
      }
      callValidate(c2)
        .then(function (data) {
          if (data && data.valid === true) {
            writeCachedOk(resourceKey)
            unlock()
          } else {
            showDenied((data && data.message) || "アクセス権限がありません。")
          }
        })
        .catch(function () {
          showDenied("検証サーバーに接続できませんでした。")
        })
    })
  }

  // defer 指定済みなので readyState は interactive/complete のはず。即座に走らせる。
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start)
  } else {
    start()
  }
})()

/**
 * 外部サイト用 トークンゲート（NSID + masterToken 方式）。
 * URL に ?token= は載せない。アカウント単位の権利をスプレッドシートで確認する。
 *
 * 必要な設定：
 *  - TOKEN_GATE_ORIGIN: 任務ポータルのオリジン（postMessage 通信先＆Next API のホスト）
 *  - <head> で window.__TOKEN_RESOURCE_KEY__ を設定（例: "ext:urban-legend-board"）
 *
 * 任意のフック：
 *  - window.__TOKEN_DENIED__(message) でサイトの雰囲気に合った全面エラーを表示
 *    （未定義時はデフォルトの黒画面オーバーレイ）
 *
 * 認証の取り方：
 *  1) localStorage の ns_login_id / ns_master_token / ns_case_id を読む
 *  2) 無ければ window.opener へ postMessage(NS_AUTH_REQUEST) で要求し、
 *     ポータルから NS_AUTH_GRANT で受け取り localStorage に保存
 *  3) /api/platform/validate-entitlement に POST して権利確認
 */
;(function () {
  var TOKEN_GATE_ORIGIN = "https://nazo-portal.vercel.app"
  var LS_LOGIN = "ns_login_id"
  var LS_MASTER = "ns_master_token"
  var LS_CASE = "ns_case_id"
  var MSG_REQUEST = "NS_AUTH_REQUEST"
  var MSG_GRANT = "NS_AUTH_GRANT"

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

  function bootstrapFromOpener() {
    return new Promise(function (resolve) {
      if (!window.opener || window.opener.closed) {
        resolve(null)
        return
      }
      var finished = false
      var tries = 0
      var poll = setInterval(function () {
        if (finished) return
        tries++
        if (tries > 80) {
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
      }, 250)

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

  function applyValidation(data) {
    if (data && data.valid === true) {
      cleanUrlToken()
      document.documentElement.classList.add("token-gate-ok")
      return true
    }
    return false
  }

  function denyFromValidation(data) {
    var msg = (data && data.message) || "アクセス権限がありません。"
    showDenied(msg)
  }

  function start() {
    cleanUrlToken()
    var c = readCreds()
    if (c.loginId && c.masterToken && c.caseId) {
      callValidate(c)
        .then(function (data) {
          if (!applyValidation(data)) {
            clearCreds()
            bootstrapFromOpener().then(function (c2) {
              if (!c2) {
                denyFromValidation(data)
                return
              }
              callValidate(c2).then(function (d2) {
                if (!applyValidation(d2)) denyFromValidation(d2)
              })
            })
          }
        })
        .catch(function () {
          showDenied("検証サーバーに接続できませんでした。")
        })
      return
    }
    bootstrapFromOpener().then(function (c2) {
      if (!c2) {
        showDenied(
          "このページを単独で開くには、先に任務ポータルにログインし、対象作品をプレイ開始してください。"
        )
        return
      }
      callValidate(c2)
        .then(function (data) {
          if (!applyValidation(data)) denyFromValidation(data)
        })
        .catch(function () {
          showDenied("検証サーバーに接続できませんでした。")
        })
    })
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start)
  } else {
    start()
  }
})()

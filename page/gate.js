// gate.js — the door magpie serves at /_magpie/plugin/<token>/gate.html.
//
// That document policy is connect-src none: it loads its own files and
// reaches nothing, this plugin service included. The service serves the real
// page (index.html) under a policy that names its own root, so this door
// takes the reader there: the bridge says where the service is, and the
// frame navigates. A navigation is not a fetch, so connect-src does not
// come into it.
//
// A window that gives no service is the desktop app, where 127.0.0.1 is
// this computer: the port package.json names is used there.
(async () => {
  const el = document.getElementById("s")
  const say = (t) => { if (el) el.textContent = t }
  try {
    await magpie.ready
    if (magpie.service) {
      location.replace(magpie.service)
      return
    }
    location.replace("http://127.0.0.1:3477/")
  } catch (e) {
    say("无法连接：" + (e && e.message ? e.message : e))
  }
})()

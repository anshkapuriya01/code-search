// Loaded synchronously in <head>: marks that scripts run, so entrance styles only hide content when
// the motion layer is there to reveal it. Without this class every element stays visible.
document.documentElement.classList.add("js");

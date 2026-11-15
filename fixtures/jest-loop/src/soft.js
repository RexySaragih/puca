/** Soft predicate — typeof-only tests leave EqualityOperator survivors. */
function isReady(flag) {
  return flag === true;
}

function label(on) {
  return on ? "on" : "off";
}

module.exports = { isReady, label };

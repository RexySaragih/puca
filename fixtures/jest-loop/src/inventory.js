function stockLeft(onHand, reserved) {
  return onHand - reserved;
}

module.exports = { stockLeft };

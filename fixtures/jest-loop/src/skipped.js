function skippedAdd(a, b) {
  // puca-disable-next-line
  return a + b;
}

function keptMul(a, b) {
  return a * b;
}

module.exports = { skippedAdd, keptMul };

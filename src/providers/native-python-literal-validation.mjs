// Literal-value validation for the ``python_list`` final shape.
//
// Ports the ``ast.literal_eval``-equivalent node checks extracted from
// ``native-python-list-literal.mjs``: ``numKind``/``signedNumKind`` mirror
// CPython ``_convert_num``/``_convert_signed_num`` (the real+/-complex rule
// and the single-signed-Constant restriction), ``isHashable`` rejects
// unhashable set elements and dict keys (a bounded rejection of what CPython
// raises as an uncaught ``TypeError``), and ``validateLiteral`` walks the
// parsed AST the recursive-descent parser produces, accepting exactly the
// literal forms ``ast.literal_eval`` accepts: Constant, Tuple/List/Set/Dict,
// the empty ``set()`` call, signed numeric UnaryOp, and the real+complex BinOp.
//
// These are pure functions over the plain-data AST node records the parser
// emits; they hold no parser/tokenizer state and import nothing.

export function numKind(node) {
  // ``_convert_num``: a Constant whose value is int/float/complex. ``bool`` is
  // NOT accepted here (``type(True) is bool``, not int), so bool operands reject
  // in arithmetic contexts even though they are valid Constants elsewhere.
  if (node.kind === "Constant") {
    if (node.valueType === "int") return "int";
    if (node.valueType === "float") return "float";
    if (node.valueType === "complex") return "complex";
  }
  return null;
}

export function signedNumKind(node) {
  // ``_convert_signed_num``: a numeric Constant, or a single ``+``/``-`` UnaryOp
  // on a numeric Constant (NOT bool, NOT nested unary).
  if (node.kind === "Constant") return numKind(node);
  if (node.kind === "UnaryOp" && (node.op === "UAdd" || node.op === "USub")) {
    return numKind(node.operand);
  }
  return null;
}

export function isHashable(node) {
  switch (node.kind) {
    case "Constant":
      return true; // str/bytes/int/float/complex/bool/none/ellipsis all hashable
    case "Tuple":
      return node.elts.every(isHashable);
    case "UnaryOp":
      return numKind(node.operand) !== null; // numeric signed value
    case "BinOp":
      // A valid real+complex BinOp evaluates to a complex number (hashable).
      return (
        (node.op === "Add" || node.op === "Sub") &&
        (signedNumKind(node.left) === "int" || signedNumKind(node.left) === "float") &&
        numKind(node.right) === "complex"
      );
    default:
      return false; // List, Set, Dict, Name, Call are unhashable
  }
}

export function validateLiteral(node) {
  switch (node.kind) {
    case "Constant":
      return !node.isFstring;
    case "List":
    case "Tuple":
      return node.elts.every(validateLiteral);
    case "Set":
      return node.elts.every((e) => validateLiteral(e) && isHashable(e));
    case "Dict":
      for (let i = 0; i < node.keys.length; i++) {
        if (!validateLiteral(node.values[i])) return false;
        if (!validateLiteral(node.keys[i]) || !isHashable(node.keys[i])) return false;
      }
      return true;
    case "UnaryOp":
      // ``_convert_signed_num``: operand must be a numeric Constant (not bool,
      // not nested unary); ``--1``/``-True`` reject.
      return (node.op === "UAdd" || node.op === "USub") && numKind(node.operand) !== null;
    case "BinOp":
      // ``_convert`` BinOp branch: left = signed real, right = complex Constant.
      // ``1+2j``/``-1-2j`` accept; ``1+2``/``2j+1``/nested reject.
      return (
        (node.op === "Add" || node.op === "Sub") &&
        (signedNumKind(node.left) === "int" || signedNumKind(node.left) === "float") &&
        numKind(node.right) === "complex"
      );
    case "Call":
      // Only the empty ``set()`` call is a literal.
      return (
        node.func.kind === "Name" &&
        node.func.value === "set" &&
        node.args.length === 0
      );
    default:
      return false; // Name (bare) and any unknown node
  }
}

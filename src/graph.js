var xtend = require("xtend"),
    minimatch = require("minimatch");

function generateBuildGraph(inputs, rules) {
  function itr(buckets, operations, outputs) {
    var change = false,
        newOutputs = []; //new outputs

    function glob(pattern) {
      var matches = [];
      outputs.forEach(function(out) {
        if(minimatch(out, pattern))
          matches.push(out);
      });
      return matches;
    }

    rules.forEach(function(rule, i) {
      var bucket = buckets[i];
      if(rule.each) checkInput(rule.input);
      else rule.inputs.forEach(checkInput);

      function checkInput(input) {
        glob(input).forEach(function(match) {
          if(!bucket[match]) {
            change = true;
            var output = outputForInput(rule, match);
            if(rule.each) {
              bucket[match] = new Operation(rule.op, match, output, 1);
            } else if (!operations[i]) {
              bucket[match] = operations[i] = new Operation(rule.op, match, output, 1);
            } else {
              bucket[match] = operations[i];
              operations[i].inputs.push(match);
              operations[i].inEdges++;
            }

            newOutputs.push(output);
          }
        });
      }
    });
    
    if(change) return itr(buckets, operations, newOutputs);
    else return buckets;
  }

  return mergeBuckets(itr(genObjectArray(rules.length), [], cloneArray(inputs)));
}

function cloneArray(arr) {
  return arr.filter(function(i) { return i; });
}

function outputForInput(rule, input) {
  if(typeof rule.output === "function") 
    return rule.output(input);
  return rule.output;
}

function genObjectArray(n) {
  var arr = [];
  for(; n > 0; n--) arr.push({});
  return arr;
}

function mergeBuckets(objs) {
  return objs.reduce(function(prev, obj) {
    var arr = [];
    for(var input in obj) {
      var output = obj[input];
      arr.push([input, output]);
    }
    return prev.concat(arr);
  }, []);
}

function edgeListToGraph(edges) {
  console.log(edges);
  return {};
}

//A unique transformation or task. In the case of `each` rules, many operation
//nodes may exist for a single rule definition.
function Operation(fn, inputs, output, inEdges) {
  this.fn = fn;
  this.output = output;
  this.inputs = toArray(inputs);
  this.inEdges = inEdges;
  this.inComplete = 0;
}

function toArray(arr) {
  if(Array.isArray(arr)) return arr;
  else return [arr];
}

module.exports = generateBuildGraph;

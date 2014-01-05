var nopt = require("nopt"),
    through = require("through"),
    glob = require("glob"),
    path = require("path"),
    minimatch = require("minimatch"),
    Promise = require("promise"),
    isPromise = require("is-promise"),
    fs = require("fs"),
    mkdirp = require("mkdirp"),
    assert = require("assert"),
    Writable = require("stream").Writable;

function fez(module) {
  var rules = [];

  function defineRule(inputs, outputs, operation) {
    toArray(outputs).forEach(function(output) {
      rules.push({ inputs: toArray(inputs), outputs: [output], op: operation });
    });
  }

  //Repeat the rule for each input
  defineRule.each = function(inputs, outputs, operation) {
    toArray(inputs).forEach(function(input) {
      rules.push({ inputs: [input], outputs: toArray(outputs), op: operation, each: true });
    });
  };

  //Pass complete input and output arrays to operation
  defineRule.many = function(inputs, outputs, operation) {
    rules.push({ inputs: toArray(inputs), outputs: toArray(outputs), op: operation, many: true });
  };

  module.exports.default(defineRule);

  var outs = [];

  function oglob(pattern) {
    var matches = [];
    outs.forEach(function(out) {
      if(minimatch(out, pattern))
        matches.push(out);
    });
    return matches;
  }

  rules.forEach(function(rule) {
    rule.files = {};
    rule.inputs.forEach(function(input) {
      var files = glob.sync(input);
      files.forEach(function(file) {
        var out;
        if(rule.each) {
          out = rule.outputs[0](file);
        } else {
          out = rule.outputs[0];
        }

        outs.push(out);

        rule.files[file] = out;
      });
    });
  });

  //(ibw) need to figure out some form of cycle detection
  var changed = true;
  while(changed) {
    changed = false;
    rules.forEach(function(rule) {
      rule.inputs.forEach(function(input) {
        var files = oglob(input);
        files.forEach(function(file) {
          if(!rule.files[file]) {
            changed = true;

            var out;
            if(rule.each)
              out = rule.outputs[0](file);
            else
              out = rule.outputs[0];

            outs.push(out);

            rule.files[file] = out;
          }
        });
      });
    });
  }

  var inEdges = {};
  var nodes = {};
  rules.forEach(function(rule) {
    for(var input in rule.files) {
      var output = rule.files[input];
      if(inEdges[output]) inEdges[output]++;
      else inEdges[output] = 1;

      var node;
      if(!nodes[output]) {
        node = nodes[output] = [];
        node.inComplete = 0;
        node.file = output;
        node.inFiles = [input];
        node.rule = rule;
      } else {
        nodes[output].inFiles.push(input);
        nodes[output].rule = rule;
      }

      if(!inEdges[input]) inEdges[input] = 0;
      if(!nodes[input]) {
        node = nodes[input] = [];
        node.inComplete = 0;
        node.file = input;
        node.inFiles = [];
      }

      nodes[input].push(output);
    }

    delete rule.files;
  });
  
  var working = [];
  for(var file in inEdges) {
    var rank = inEdges[file];
    if(rank === 0) working.push(file);
  }

  digest(working);

  function digest(working) {
    //console.log(working);
    if(!working.length) return;

    var newWorking = [];
    var ps = [];
    working.forEach(function(file) {
      var node = nodes[file];
      if(node.inComplete == inEdges[file]) {
        if(node.inFiles.length > 0) {
          ps.push(build(node));
        }

        node.forEach(function(out) {
          nodes[out].inComplete++;
          if(newWorking.indexOf(out) == -1)
            newWorking.push(out); 
        });
      } else {
        newWorking.push(file);
      }
    });

    Promise.all(ps).then(function() {
      digest(newWorking);
    });
  }

  function build(node) {
    if(needsUpdate(node.inFiles, [node.file])) {
      console.log(node.inFiles.join(" "), "->", node.file);
      var inputs = [];
      node.inFiles.forEach(function(file) {
        inputs.push(new Input(file));
      });

      var out = node.rule.op(inputs);
      if(isPromise(out)) {
        return out.then(function(buffer) {
          if(buffer !== undefined) { //(ibw) assume it's a Buffer (for now)
            var ps = [];
            ps.push(writep(node.file, buffer));

            return Promise.all(ps);
          }
        });
      } else if(out instanceof Writable) {
        return new Promise(function(resolve, reject) {
          out.pipe(fs.createWriteStream(node.file));
          out.on("end", function() {
            resolve();
          });
        });
      }
    }
  }
}

fez.mapFile = function(pattern) {
  return function(input) {
    var f = (function() {
      var basename = path.basename(input);
      var hidden = false;
      if(basename.charAt(0) == ".") {
        hidden = true;
        basename = basename.slice(1);
      }

      var split = basename.split(".");
      if(split.length > 1) {
        if(hidden) return "." + split.slice(0, -1).join(".");
        else return split.slice(0, -1).join(".");
      } else {
        if(hidden) return "." + basename;
        else return basename;
      }
    })();

    return pattern.replace("%f", f);
  };
};

function Input(filename) {
  this._filename = filename;
}

Input.prototype.asBuffer = function() {
  var file = this._filename;
  return new Promise(function(resolve, reject) {
    fs.readFile(file, function(err, data) {
      if(err) reject(err);
      else resolve(data);
    });
  });
};

Input.prototype.asStream = function() {

};

Input.prototype.getFilename = function() {
  return this._filename;
};

function toArray(obj) {
  if(Array.isArray(obj)) return obj;
  return [obj];
}

function writep(file, data) {
  return new Promise(function(resolve, reject) {
    mkdirp(path.dirname(file), function(err) {
      if(err) reject(err);
      fs.writeFile(file, data, function(err) {
        if(err) reject(err);
        else resolve();
      });
    });
  });
}

function needsUpdate(inputs, outputs) {
  var oldestOutput = Number.MAX_VALUE;
  outputs.forEach(function(out) {
    var dir = path.dirname(out);
    if(mkdirp.sync(dir)) {
      oldestOutput = 0;
    } else {
      try {
        var stat = fs.statSync(out),
            time = stat.mtime.getTime();

        if(time < oldestOutput)
          oldestOutput = time;
      } catch (e) {
        oldestOutput = 0;
      }
    }
  });

  var newestInput = 0;
  inputs.forEach(function(input) {
    try {
      var stat = fs.statSync(input),
          time = stat.mtime.getTime();

      if(time > newestInput)
        newestInput = time;
    } catch(e) {
      newestInput = 0;
    }
  });

  return newestInput > oldestOutput;
}

function union(a, b) {
  var a2 = a.filter(function() { return true; });
  b.forEach(function(e) {
    if(a.indexOf(e) == -1)
      a2.push(e);
  });

  return a2;
}

module.exports = fez;

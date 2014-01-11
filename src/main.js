var nopt = require("nopt"),
    ansi = require("ansi"),
    cursor = ansi(process.stdout),
    through = require("through"),
    glob = require("glob"),
    path = require("path"),
    minimatch = require("minimatch"),
    Promise = require("bluebird"),
    isPromise = require("is-promise"),
    fs = require("fs"),
    mkdirp = require("mkdirp"),
    assert = require("assert"),
    Writable = require("stream").Writable,
    exec = require("child_process").exec,
    Input = require("./input"),
    generateBuildGraph = require("./graph"),
    fezUtil = require("./util"),
    xtend = require("xtend/mutable");

/*****************
 *     --o--     *
 *    |   ) |    *
 *    |    )|    *
 *    +----)+    *
 *      FEZ      *
 *****************/

function fez(module) {
  var options = nopt({
    "verbose": Boolean,
    "quiet": Boolean,
    "clean": Boolean
  }, {
    "v": "--verbose",
    "q": "--quet",
    "c": "--clean"
  });

  var ruleset = options.argv.remain.length ? options.argv.remain[0] : 'default';
  stage(module.exports[ruleset], false, options);
}

function createRuleFns(rules, requires) {
  function defineRule(inputs, output, operation) {
    if(typeof output !== "string") throw new Error("Output argument of rule() must be a string");

    rules.push({ inputs: toArray(inputs), output: output, op: operation });
  }

  //One to one relationships where you want to pass in multiple inputs (i.e
  //from a glob, array, or generator). Repeats the operation for each input
  //with the output. I'M NOT SURE I LIKE THE SEMANTICS OF THIS FUNCTION. USE
  //AT YOUR OWN RISK. -ibw
  defineRule.each = function(input, output, operation) {
    if(typeof output !== "function") throw new Error("Output argument of rule.each() must be a function");

    //(ibw) will need to add a mechanism for array inputs once I sort out the
    //semantics. See https://gist.github.com/isaacbw/8311616 for a possible
    //use case.
    if(Array.isArray(input)) throw new Error("Input argument of rule.each() must be a string");

    rules.push({ input: input, output: output, op: operation, each: true });
  };

  //Pass complete input and output arrays to operation Useful for many-many
  //operations, which should really be limited to shell commands. Native fez
  //operations should try very hard to be one-one or many-one operations with a
  //single output.
  defineRule.many = function(inputs, outputs, operation) {
    rules.push({ inputs: toArray(inputs), outputs: toArray(outputs), op: operation, many: true });
  };
  
  //A task is a special rule which has no output. It will be run each time the
  //ruleset is run, since there are no output files with which to compare
  //timestamps.
  defineRule.task = function(inputs, operation) {
    rules.push({ inputs: toArray(inputs), op: operation, task: true });
  };

  defineRule.task.each = function(inputs, operation) {
    toArray(inputs).forEach(function(input) {
      rules.push({ inputs: [input], op: operation, task: true, each: true });
    });
  };

  defineRule.requires = function(ruleset) {
    requires = requires.concat(toArray(ruleset));
  };

  return defineRule;
}

function stage(ruleset, isChild, options) {
  var rules = [], requires = [];

  //One to one or many to one relationships. Repeats the operation for each
  //output if there are multiple, passing the complete input array each time.
  var defineRule = createRuleFns(rules, requires);
  ruleset(defineRule);

  return new Promise(function() {
    var anyWorkDone = false;
    return (function nextRequire(prevWorkDone) {
      if(requires.length) {
        return stage(requires.shift(), true, options).then(function(workDone) {
          anyWorkDone = anyWorkDone || workDone;
          return nextRequire();
        });
      } else {
        return work(rules, options, isChild, anyWorkDone);
      }
    })();
  });
}

function work(rules, options, isChild, prevWorkDone) {
  return new Promise(function(resolve, reject) {
    var outs = [],
        nextTask = 0;

    var nodes = generateBuildGraph(getAllMatchingInputs(rules), rules),
        working = [],
        createdCount = 0,
        taskCount = 0;

    nodes.forEach(function(node) {
      if(node.isFile() && node.inputs.length === 0) working.push(node);
    });

    digest(nodes, working, options).then(done);

    function done(anyWorkDone) {
      if(!anyWorkDone === 0 && !options.quiet) {
        if(!isChild && !prevWorkDone) {
          console.log("Nothing to be done.");
        }

        resolve(false || prevWorkDone);
      } else {
        if(!isChild && prevWorkDone) {
          console.log("Success.");
        }
        reject(true);
      }
    }

  });
}

function tasksForInput(edges, input) {
  var result = [];
  for(var i = 0; i < edges.length; i++) {
    var edge = edges[i];
    if(edge[0] === input) {
      result.push(edge[1]);
    }
  }

  return result;
}

function performOperation(options, op) {
  if(options.verbose) {
    console.log(op.inputs.map(function(i) { return i.file; }).join(" "), "->", op.output.file);
  }

  var inputs = op.inputs.map(function(i) { return i.file; }),
      output = op.output.file;

  if(needsUpdate(inputs, [output])) {
    process.stdout.write("Creating ");
    cursor.green();
    process.stdout.write(output + "\n"); 
    cursor.reset();

    var out = op.fn(buildInputs(inputs), [output]);
    if(isPromise(out)) {
      return out.then(function(buffer) {
        if(buffer !== undefined) { //(ibw) assume it's a Buffer (for now)
          return writep(output, buffer);
        } else {
          return true;
        }
      });
    } else if(out instanceof Writable) {
      return new Promise(function(resolve, reject) {
        out.pipe(fs.createWriteStream(op.output));
        out.on("end", function() {
          resolve();
        });
      });
    } else if(typeof out === "string") {
      return writep(output, new Buffer(out));
    } else if(out instanceof Buffer) {
      return writep(output, out);
    } else {
      throw new Error("Invalid operation output:", out);
    }
  } else {
    return false;
  }
}

function buildInputs(files) {
  var inputs = [];
  files.forEach(function(file) {
    inputs.push(new Input(file));
  });

  inputs.asBuffers = function() {
    return this.map(function(i) { return i.asBuffer(); });
  };

  return inputs;
}

function digest(nodes, working, options) {
  if(working.length === 0) return false;

  var newWorking = [];
  var promises = [];
  working.forEach(function(node) {
    if(node.isFile()) {
      node.outputs.forEach(function(out) {
        out.inComplete++;
        if(newWorking.indexOf(out) === -1)
          newWorking.push(out);
      });
    } else {//It's an operation
      //Is it ready to go?
      if(node.inComplete === node.inputs.length) {
        //Yes, do the operation and put the output on the working list
        promises.push(performOperation(options, node));
        newWorking.push(node.output);
      } else {
        //No, put it back on the working list
        newWorking.push(node);
      }
    }
  });

  return Promise.settle(promises).then(function(results) {
    var anyRejected = false;
    var anyWorkDone = false;
    results.forEach(function(i) {
      if(i.isRejected()) {
        anyRejected = true;
        console.log(i);
      } else {
        anyWorkdDone = anyWorkDone || i.value();
      }
    });

    if(anyRejected) {
      if(!options.quiet) {
        console.log("An operation has failed. Aborting.");
        return anyWorkDone;
      }
    } else {
      return digest(nodes, newWorking, options) || anyWorkDone;
    }
  });
}

xtend(fez, fezUtil);

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

//(ibw) should switch to a real set data structure for maximum performance
function union(a, b) {
  var a2 = a.filter(function() { return true; });
  b.forEach(function(e) {
    if(a.indexOf(e) == -1)
      a2.push(e);
  });

  return a2;
}

function merge(arrays) {
  return arrays.reduce(function(prev, array) {
    return prev.concat(array);
  }, []);
}

function getAllMatchingInputs(rules) {
  return merge(rules.map(getMatchingInputs));
}

function getMatchingInputs(rule) {
  if(rule.each) return glob.sync(rule.input);
  return merge(rule.inputs.map(function(globstring) {
    return glob.sync(globstring);
  }));
}

module.exports = fez;


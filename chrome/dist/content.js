"use strict";
(() => {
  // node_modules/turndown/lib/turndown.browser.es.js
  function extend(destination) {
    for (var i = 1; i < arguments.length; i++) {
      var source = arguments[i];
      for (var key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key))
          destination[key] = source[key];
      }
    }
    return destination;
  }
  function repeat(character, count) {
    return Array(count + 1).join(character);
  }
  function trimLeadingNewlines(string) {
    return string.replace(/^\n*/, "");
  }
  function trimTrailingNewlines(string) {
    var indexEnd = string.length;
    while (indexEnd > 0 && string[indexEnd - 1] === "\n")
      indexEnd--;
    return string.substring(0, indexEnd);
  }
  function trimNewlines(string) {
    return trimTrailingNewlines(trimLeadingNewlines(string));
  }
  var blockElements = ["ADDRESS", "ARTICLE", "ASIDE", "AUDIO", "BLOCKQUOTE", "BODY", "CANVAS", "CENTER", "DD", "DIR", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "FRAMESET", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HGROUP", "HR", "HTML", "ISINDEX", "LI", "MAIN", "MENU", "NAV", "NOFRAMES", "NOSCRIPT", "OL", "OUTPUT", "P", "PRE", "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL"];
  function isBlock(node) {
    return is(node, blockElements);
  }
  var voidElements = ["AREA", "BASE", "BR", "COL", "COMMAND", "EMBED", "HR", "IMG", "INPUT", "KEYGEN", "LINK", "META", "PARAM", "SOURCE", "TRACK", "WBR"];
  function isVoid(node) {
    return is(node, voidElements);
  }
  function hasVoid(node) {
    return has(node, voidElements);
  }
  var meaningfulWhenBlankElements = ["A", "TABLE", "THEAD", "TBODY", "TFOOT", "TH", "TD", "IFRAME", "SCRIPT", "AUDIO", "VIDEO"];
  function isMeaningfulWhenBlank(node) {
    return is(node, meaningfulWhenBlankElements);
  }
  function hasMeaningfulWhenBlank(node) {
    return has(node, meaningfulWhenBlankElements);
  }
  function is(node, tagNames) {
    return tagNames.indexOf(node.nodeName) >= 0;
  }
  function has(node, tagNames) {
    return node.getElementsByTagName && tagNames.some(function(tagName) {
      return node.getElementsByTagName(tagName).length;
    });
  }
  var markdownEscapes = [[/\\/g, "\\\\"], [/\*/g, "\\*"], [/^-/g, "\\-"], [/^\+ /g, "\\+ "], [/^(=+)/g, "\\$1"], [/^(#{1,6}) /g, "\\$1 "], [/`/g, "\\`"], [/^~~~/g, "\\~~~"], [/\[/g, "\\["], [/\]/g, "\\]"], [/^>/g, "\\>"], [/_/g, "\\_"], [/^(\d+)\. /g, "$1\\. "]];
  function escapeMarkdown(string) {
    return markdownEscapes.reduce(function(accumulator, escape) {
      return accumulator.replace(escape[0], escape[1]);
    }, string);
  }
  var rules = {};
  rules.paragraph = {
    filter: "p",
    replacement: function(content) {
      return "\n\n" + content + "\n\n";
    }
  };
  rules.lineBreak = {
    filter: "br",
    replacement: function(content, node, options) {
      return options.br + "\n";
    }
  };
  rules.heading = {
    filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
    replacement: function(content, node, options) {
      var hLevel = Number(node.nodeName.charAt(1));
      if (options.headingStyle === "setext" && hLevel < 3) {
        var underline = repeat(hLevel === 1 ? "=" : "-", content.length);
        return "\n\n" + content + "\n" + underline + "\n\n";
      } else {
        return "\n\n" + repeat("#", hLevel) + " " + content + "\n\n";
      }
    }
  };
  rules.blockquote = {
    filter: "blockquote",
    replacement: function(content) {
      content = trimNewlines(content).replace(/^/gm, "> ");
      return "\n\n" + content + "\n\n";
    }
  };
  rules.list = {
    filter: ["ul", "ol"],
    replacement: function(content, node) {
      var parent = node.parentNode;
      if (parent.nodeName === "LI" && parent.lastElementChild === node) {
        return "\n" + content;
      } else {
        return "\n\n" + content + "\n\n";
      }
    }
  };
  rules.listItem = {
    filter: "li",
    replacement: function(content, node, options) {
      var prefix = options.bulletListMarker + "   ";
      var parent = node.parentNode;
      if (parent.nodeName === "OL") {
        var start = parent.getAttribute("start");
        var index = Array.prototype.indexOf.call(parent.children, node);
        prefix = (start ? Number(start) + index : index + 1) + ".  ";
      }
      var isParagraph = /\n$/.test(content);
      content = trimNewlines(content) + (isParagraph ? "\n" : "");
      content = content.replace(/\n/gm, "\n" + " ".repeat(prefix.length));
      return prefix + content + (node.nextSibling ? "\n" : "");
    }
  };
  rules.indentedCodeBlock = {
    filter: function(node, options) {
      return options.codeBlockStyle === "indented" && node.nodeName === "PRE" && node.firstChild && node.firstChild.nodeName === "CODE";
    },
    replacement: function(content, node, options) {
      return "\n\n    " + node.firstChild.textContent.replace(/\n/g, "\n    ") + "\n\n";
    }
  };
  rules.fencedCodeBlock = {
    filter: function(node, options) {
      return options.codeBlockStyle === "fenced" && node.nodeName === "PRE" && node.firstChild && node.firstChild.nodeName === "CODE";
    },
    replacement: function(content, node, options) {
      var className = node.firstChild.getAttribute("class") || "";
      var language = (className.match(/language-(\S+)/) || [null, ""])[1];
      var code = node.firstChild.textContent;
      var fenceChar = options.fence.charAt(0);
      var fenceSize = 3;
      var fenceInCodeRegex = new RegExp("^" + fenceChar + "{3,}", "gm");
      var match;
      while (match = fenceInCodeRegex.exec(code)) {
        if (match[0].length >= fenceSize) {
          fenceSize = match[0].length + 1;
        }
      }
      var fence = repeat(fenceChar, fenceSize);
      return "\n\n" + fence + language + "\n" + code.replace(/\n$/, "") + "\n" + fence + "\n\n";
    }
  };
  rules.horizontalRule = {
    filter: "hr",
    replacement: function(content, node, options) {
      return "\n\n" + options.hr + "\n\n";
    }
  };
  rules.inlineLink = {
    filter: function(node, options) {
      return options.linkStyle === "inlined" && node.nodeName === "A" && node.getAttribute("href");
    },
    replacement: function(content, node) {
      var href = escapeLinkDestination(node.getAttribute("href"));
      var title = escapeLinkTitle(cleanAttribute(node.getAttribute("title")));
      var titlePart = title ? ' "' + title + '"' : "";
      return "[" + content + "](" + href + titlePart + ")";
    }
  };
  rules.referenceLink = {
    filter: function(node, options) {
      return options.linkStyle === "referenced" && node.nodeName === "A" && node.getAttribute("href");
    },
    replacement: function(content, node, options) {
      var href = escapeLinkDestination(node.getAttribute("href"));
      var title = cleanAttribute(node.getAttribute("title"));
      if (title)
        title = ' "' + escapeLinkTitle(title) + '"';
      var replacement;
      var reference;
      switch (options.linkReferenceStyle) {
        case "collapsed":
          replacement = "[" + content + "][]";
          reference = "[" + content + "]: " + href + title;
          break;
        case "shortcut":
          replacement = "[" + content + "]";
          reference = "[" + content + "]: " + href + title;
          break;
        default:
          var id = this.references.length + 1;
          replacement = "[" + content + "][" + id + "]";
          reference = "[" + id + "]: " + href + title;
      }
      this.references.push(reference);
      return replacement;
    },
    references: [],
    append: function(options) {
      var references = "";
      if (this.references.length) {
        references = "\n\n" + this.references.join("\n") + "\n\n";
        this.references = [];
      }
      return references;
    }
  };
  rules.emphasis = {
    filter: ["em", "i"],
    replacement: function(content, node, options) {
      if (!content.trim())
        return "";
      return options.emDelimiter + content + options.emDelimiter;
    }
  };
  rules.strong = {
    filter: ["strong", "b"],
    replacement: function(content, node, options) {
      if (!content.trim())
        return "";
      return options.strongDelimiter + content + options.strongDelimiter;
    }
  };
  rules.code = {
    filter: function(node) {
      var hasSiblings = node.previousSibling || node.nextSibling;
      var isCodeBlock = node.parentNode.nodeName === "PRE" && !hasSiblings;
      return node.nodeName === "CODE" && !isCodeBlock;
    },
    replacement: function(content) {
      if (!content)
        return "";
      content = content.replace(/\r?\n|\r/g, " ");
      var extraSpace = /^`|^ .*?[^ ].* $|`$/.test(content) ? " " : "";
      var delimiter = "`";
      var matches = content.match(/`+/gm) || [];
      while (matches.indexOf(delimiter) !== -1)
        delimiter = delimiter + "`";
      return delimiter + extraSpace + content + extraSpace + delimiter;
    }
  };
  rules.image = {
    filter: "img",
    replacement: function(content, node) {
      var alt = escapeMarkdown(cleanAttribute(node.getAttribute("alt")));
      var src = escapeLinkDestination(node.getAttribute("src") || "");
      var title = cleanAttribute(node.getAttribute("title"));
      var titlePart = title ? ' "' + escapeLinkTitle(title) + '"' : "";
      return src ? "![" + alt + "](" + src + titlePart + ")" : "";
    }
  };
  function cleanAttribute(attribute) {
    return attribute ? attribute.replace(/(\n+\s*)+/g, "\n") : "";
  }
  function escapeLinkDestination(destination) {
    var escaped = destination.replace(/([<>()])/g, "\\$1");
    return escaped.indexOf(" ") >= 0 ? "<" + escaped + ">" : escaped;
  }
  function escapeLinkTitle(title) {
    return title.replace(/"/g, '\\"');
  }
  function Rules(options) {
    this.options = options;
    this._keep = [];
    this._remove = [];
    this.blankRule = {
      replacement: options.blankReplacement
    };
    this.keepReplacement = options.keepReplacement;
    this.defaultRule = {
      replacement: options.defaultReplacement
    };
    this.array = [];
    for (var key in options.rules)
      this.array.push(options.rules[key]);
  }
  Rules.prototype = {
    add: function(key, rule) {
      this.array.unshift(rule);
    },
    keep: function(filter) {
      this._keep.unshift({
        filter,
        replacement: this.keepReplacement
      });
    },
    remove: function(filter) {
      this._remove.unshift({
        filter,
        replacement: function() {
          return "";
        }
      });
    },
    forNode: function(node) {
      if (node.isBlank)
        return this.blankRule;
      var rule;
      if (rule = findRule(this.array, node, this.options))
        return rule;
      if (rule = findRule(this._keep, node, this.options))
        return rule;
      if (rule = findRule(this._remove, node, this.options))
        return rule;
      return this.defaultRule;
    },
    forEach: function(fn) {
      for (var i = 0; i < this.array.length; i++)
        fn(this.array[i], i);
    }
  };
  function findRule(rules2, node, options) {
    for (var i = 0; i < rules2.length; i++) {
      var rule = rules2[i];
      if (filterValue(rule, node, options))
        return rule;
    }
    return void 0;
  }
  function filterValue(rule, node, options) {
    var filter = rule.filter;
    if (typeof filter === "string") {
      if (filter === node.nodeName.toLowerCase())
        return true;
    } else if (Array.isArray(filter)) {
      if (filter.indexOf(node.nodeName.toLowerCase()) > -1)
        return true;
    } else if (typeof filter === "function") {
      if (filter.call(rule, node, options))
        return true;
    } else {
      throw new TypeError("`filter` needs to be a string, array, or function");
    }
  }
  function collapseWhitespace(options) {
    var element = options.element;
    var isBlock2 = options.isBlock;
    var isVoid2 = options.isVoid;
    var isPre = options.isPre || function(node2) {
      return node2.nodeName === "PRE";
    };
    if (!element.firstChild || isPre(element))
      return;
    var prevText = null;
    var keepLeadingWs = false;
    var prev = null;
    var node = next(prev, element, isPre);
    while (node !== element) {
      if (node.nodeType === 3 || node.nodeType === 4) {
        var text = node.data.replace(/[ \r\n\t]+/g, " ");
        if ((!prevText || / $/.test(prevText.data)) && !keepLeadingWs && text[0] === " ") {
          text = text.substr(1);
        }
        if (!text) {
          node = remove(node);
          continue;
        }
        node.data = text;
        prevText = node;
      } else if (node.nodeType === 1) {
        if (isBlock2(node) || node.nodeName === "BR") {
          if (prevText) {
            prevText.data = prevText.data.replace(/ $/, "");
          }
          prevText = null;
          keepLeadingWs = false;
        } else if (isVoid2(node) || isPre(node)) {
          prevText = null;
          keepLeadingWs = true;
        } else if (prevText) {
          keepLeadingWs = false;
        }
      } else {
        node = remove(node);
        continue;
      }
      var nextNode = next(prev, node, isPre);
      prev = node;
      node = nextNode;
    }
    if (prevText) {
      prevText.data = prevText.data.replace(/ $/, "");
      if (!prevText.data) {
        remove(prevText);
      }
    }
  }
  function remove(node) {
    var next2 = node.nextSibling || node.parentNode;
    node.parentNode.removeChild(node);
    return next2;
  }
  function next(prev, current, isPre) {
    if (prev && prev.parentNode === current || isPre(current)) {
      return current.nextSibling || current.parentNode;
    }
    return current.firstChild || current.nextSibling || current.parentNode;
  }
  var root = typeof window !== "undefined" ? window : {};
  function canParseHTMLNatively() {
    var Parser = root.DOMParser;
    var canParse = false;
    try {
      if (new Parser().parseFromString("", "text/html")) {
        canParse = true;
      }
    } catch (e) {
    }
    return canParse;
  }
  function createHTMLParser() {
    var Parser = function() {
    };
    {
      if (shouldUseActiveX()) {
        Parser.prototype.parseFromString = function(string) {
          var doc = new window.ActiveXObject("htmlfile");
          doc.designMode = "on";
          doc.open();
          doc.write(string);
          doc.close();
          return doc;
        };
      } else {
        Parser.prototype.parseFromString = function(string) {
          var doc = document.implementation.createHTMLDocument("");
          doc.open();
          doc.write(string);
          doc.close();
          return doc;
        };
      }
    }
    return Parser;
  }
  function shouldUseActiveX() {
    var useActiveX = false;
    try {
      document.implementation.createHTMLDocument("").open();
    } catch (e) {
      if (root.ActiveXObject)
        useActiveX = true;
    }
    return useActiveX;
  }
  var HTMLParser = canParseHTMLNatively() ? root.DOMParser : createHTMLParser();
  function RootNode(input, options) {
    var root2;
    if (typeof input === "string") {
      var doc = htmlParser().parseFromString(
        // DOM parsers arrange elements in the <head> and <body>.
        // Wrapping in a custom element ensures elements are reliably arranged in
        // a single element.
        '<x-turndown id="turndown-root">' + input + "</x-turndown>",
        "text/html"
      );
      root2 = doc.getElementById("turndown-root");
    } else {
      root2 = input.cloneNode(true);
    }
    collapseWhitespace({
      element: root2,
      isBlock,
      isVoid,
      isPre: options.preformattedCode ? isPreOrCode : null
    });
    return root2;
  }
  var _htmlParser;
  function htmlParser() {
    _htmlParser = _htmlParser || new HTMLParser();
    return _htmlParser;
  }
  function isPreOrCode(node) {
    return node.nodeName === "PRE" || node.nodeName === "CODE";
  }
  function Node2(node, options) {
    node.isBlock = isBlock(node);
    node.isCode = node.nodeName === "CODE" || node.parentNode.isCode;
    node.isBlank = isBlank(node);
    node.flankingWhitespace = flankingWhitespace(node, options);
    return node;
  }
  function isBlank(node) {
    return !isVoid(node) && !isMeaningfulWhenBlank(node) && /^\s*$/i.test(node.textContent) && !hasVoid(node) && !hasMeaningfulWhenBlank(node);
  }
  function flankingWhitespace(node, options) {
    if (node.isBlock || options.preformattedCode && node.isCode) {
      return {
        leading: "",
        trailing: ""
      };
    }
    var edges = edgeWhitespace(node.textContent);
    if (edges.leadingAscii && isFlankedByWhitespace("left", node, options)) {
      edges.leading = edges.leadingNonAscii;
    }
    if (edges.trailingAscii && isFlankedByWhitespace("right", node, options)) {
      edges.trailing = edges.trailingNonAscii;
    }
    return {
      leading: edges.leading,
      trailing: edges.trailing
    };
  }
  function edgeWhitespace(string) {
    var m = string.match(/^(([ \t\r\n]*)(\s*))(?:(?=\S)[\s\S]*\S)?((\s*?)([ \t\r\n]*))$/);
    return {
      leading: m[1],
      // whole string for whitespace-only strings
      leadingAscii: m[2],
      leadingNonAscii: m[3],
      trailing: m[4],
      // empty for whitespace-only strings
      trailingNonAscii: m[5],
      trailingAscii: m[6]
    };
  }
  function isFlankedByWhitespace(side, node, options) {
    var sibling;
    var regExp;
    var isFlanked;
    if (side === "left") {
      sibling = node.previousSibling;
      regExp = / $/;
    } else {
      sibling = node.nextSibling;
      regExp = /^ /;
    }
    if (sibling) {
      if (sibling.nodeType === 3) {
        isFlanked = regExp.test(sibling.nodeValue);
      } else if (options.preformattedCode && sibling.nodeName === "CODE") {
        isFlanked = false;
      } else if (sibling.nodeType === 1 && !isBlock(sibling)) {
        isFlanked = regExp.test(sibling.textContent);
      }
    }
    return isFlanked;
  }
  var reduce = Array.prototype.reduce;
  function TurndownService(options) {
    if (!(this instanceof TurndownService))
      return new TurndownService(options);
    var defaults = {
      rules,
      headingStyle: "setext",
      hr: "* * *",
      bulletListMarker: "*",
      codeBlockStyle: "indented",
      fence: "```",
      emDelimiter: "_",
      strongDelimiter: "**",
      linkStyle: "inlined",
      linkReferenceStyle: "full",
      br: "  ",
      preformattedCode: false,
      blankReplacement: function(content, node) {
        return node.isBlock ? "\n\n" : "";
      },
      keepReplacement: function(content, node) {
        return node.isBlock ? "\n\n" + node.outerHTML + "\n\n" : node.outerHTML;
      },
      defaultReplacement: function(content, node) {
        return node.isBlock ? "\n\n" + content + "\n\n" : content;
      }
    };
    this.options = extend({}, defaults, options);
    this.rules = new Rules(this.options);
  }
  TurndownService.prototype = {
    /**
     * The entry point for converting a string or DOM node to Markdown
     * @public
     * @param {String|HTMLElement} input The string or DOM node to convert
     * @returns A Markdown representation of the input
     * @type String
     */
    turndown: function(input) {
      if (!canConvert(input)) {
        throw new TypeError(input + " is not a string, or an element/document/fragment node.");
      }
      if (input === "")
        return "";
      var output = process.call(this, new RootNode(input, this.options));
      return postProcess.call(this, output);
    },
    /**
     * Add one or more plugins
     * @public
     * @param {Function|Array} plugin The plugin or array of plugins to add
     * @returns The Turndown instance for chaining
     * @type Object
     */
    use: function(plugin) {
      if (Array.isArray(plugin)) {
        for (var i = 0; i < plugin.length; i++)
          this.use(plugin[i]);
      } else if (typeof plugin === "function") {
        plugin(this);
      } else {
        throw new TypeError("plugin must be a Function or an Array of Functions");
      }
      return this;
    },
    /**
     * Adds a rule
     * @public
     * @param {String} key The unique key of the rule
     * @param {Object} rule The rule
     * @returns The Turndown instance for chaining
     * @type Object
     */
    addRule: function(key, rule) {
      this.rules.add(key, rule);
      return this;
    },
    /**
     * Keep a node (as HTML) that matches the filter
     * @public
     * @param {String|Array|Function} filter The unique key of the rule
     * @returns The Turndown instance for chaining
     * @type Object
     */
    keep: function(filter) {
      this.rules.keep(filter);
      return this;
    },
    /**
     * Remove a node that matches the filter
     * @public
     * @param {String|Array|Function} filter The unique key of the rule
     * @returns The Turndown instance for chaining
     * @type Object
     */
    remove: function(filter) {
      this.rules.remove(filter);
      return this;
    },
    /**
     * Escapes Markdown syntax
     * @public
     * @param {String} string The string to escape
     * @returns A string with Markdown syntax escaped
     * @type String
     */
    escape: function(string) {
      return escapeMarkdown(string);
    }
  };
  function process(parentNode) {
    var self = this;
    return reduce.call(parentNode.childNodes, function(output, node) {
      node = new Node2(node, self.options);
      var replacement = "";
      if (node.nodeType === 3) {
        replacement = node.isCode ? node.nodeValue : self.escape(node.nodeValue);
      } else if (node.nodeType === 1) {
        replacement = replacementForNode.call(self, node);
      }
      return join(output, replacement);
    }, "");
  }
  function postProcess(output) {
    var self = this;
    this.rules.forEach(function(rule) {
      if (typeof rule.append === "function") {
        output = join(output, rule.append(self.options));
      }
    });
    return output.replace(/^[\t\r\n]+/, "").replace(/[\t\r\n\s]+$/, "");
  }
  function replacementForNode(node) {
    var rule = this.rules.forNode(node);
    var content = process.call(this, node);
    var whitespace = node.flankingWhitespace;
    if (whitespace.leading || whitespace.trailing)
      content = content.trim();
    return whitespace.leading + rule.replacement(content, node, this.options) + whitespace.trailing;
  }
  function join(output, replacement) {
    var s1 = trimTrailingNewlines(output);
    var s2 = trimLeadingNewlines(replacement);
    var nls = Math.max(output.length - s1.length, replacement.length - s2.length);
    var separator = "\n\n".substring(0, nls);
    return s1 + separator + s2;
  }
  function canConvert(input) {
    return input != null && (typeof input === "string" || input.nodeType && (input.nodeType === 1 || input.nodeType === 9 || input.nodeType === 11));
  }

  // src/shared/mediaUrl.ts
  var MEDIA_VARIANT_SUFFIX_RE = /\.(png|jpe?g|webp|gif|svg|bmp|tiff?|mp4|webm|mov|m4v|avi|mkv|ogv|mp3|wav|ogg|m4a|flac|aac|pdf|csv|json|txt|md|zip|docx?|xlsx?|pptx?)(\d+)(?=$|[?#])/gi;
  function extractEmbeddedHttpUrl(value) {
    const httpsIndex = value.lastIndexOf("https://");
    const httpIndex = value.lastIndexOf("http://");
    const index = Math.max(httpsIndex, httpIndex);
    if (index >= 0) {
      return value.slice(index);
    }
    return "";
  }
  function stripUrlDecorations(value) {
    let clean = value.trim();
    const hashIndex = clean.indexOf("#");
    if (hashIndex >= 0) {
      clean = clean.slice(0, hashIndex);
    }
    const queryIndex = clean.indexOf("?");
    if (queryIndex >= 0) {
      clean = clean.slice(0, queryIndex);
    }
    try {
      clean = decodeURIComponent(clean);
    } catch {
    }
    if (clean.startsWith("file://")) {
      clean = clean.replace("file://", "");
    }
    return clean;
  }
  function stripSyntheticMediaVariantSuffix(value) {
    return value.replace(MEDIA_VARIANT_SUFFIX_RE, (_match, ext) => `.${ext}`);
  }
  function normalizeMediaReference(value) {
    const clean = stripUrlDecorations(value);
    const embedded = extractEmbeddedHttpUrl(clean);
    return stripSyntheticMediaVariantSuffix((embedded || clean).replace(/\\/g, "/"));
  }

  // src/shared/markdownCleanup.ts
  function collapseLinkedMediaWrappers(markdown) {
    let out = markdown;
    out = out.replace(/\[\s*(?:\n\s*)*(!\[[\s\S]*?\]\([^)]+\))\s*(?:\n\s*)*\]\([^)]+\)/g, "$1");
    out = out.replace(/^\[\s*$/gm, "");
    out = out.replace(/^\]\([^)]+\)\s*$/gm, "");
    return out.replace(/\n{3,}/g, "\n\n").trim();
  }

  // chrome/src/content.ts
  var PLACEHOLDER_PREFIX = "mdo-resource://";
  var IMAGE_EXTS = /* @__PURE__ */ new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp", ".tiff", ".tif"]);
  var VIDEO_EXTS = /* @__PURE__ */ new Set([".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv", ".ogv"]);
  var AUDIO_EXTS = /* @__PURE__ */ new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"]);
  var ATTACHMENT_EXTS = /* @__PURE__ */ new Set([".pdf", ".csv", ".json", ".txt", ".md", ".zip", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"]);
  function isGenericElement(node) {
    return node instanceof HTMLElement;
  }
  var captureGlobal = globalThis;
  if (!captureGlobal.__mdoCaptureListenerInstalled) {
    captureGlobal.__mdoCaptureListenerInstalled = true;
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.type !== "mdo:capture") {
        return;
      }
      Promise.resolve().then(() => captureSnapshot()).then((snapshot) => sendResponse({ ok: true, snapshot })).catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    });
  }
  function captureSnapshot() {
    const root2 = selectCaptureRoot();
    const clone = root2.cloneNode(true);
    const resources = [];
    const seen = /* @__PURE__ */ new Set();
    let seq = 0;
    convertCanvasesToImages(clone);
    removeNoiseNodes(clone);
    rewriteCapturedResources(clone, (url, kind, filenameHint) => {
      const cleaned = normalizeCapturedUrl(url);
      if (!cleaned || isIgnoredScheme(cleaned)) {
        return null;
      }
      if (seen.has(cleaned)) {
        const existing = resources.find((resource) => resource.url === cleaned);
        return existing ? `${PLACEHOLDER_PREFIX}${existing.id}` : null;
      }
      const id = `r${seq += 1}`;
      const filename = uniqueFilename(filenameHint || inferFilename(cleaned, kind), resources);
      resources.push({
        id,
        url: cleaned,
        kind,
        filename,
        mime: guessMime(filename)
      });
      seen.add(cleaned);
      return `${PLACEHOLDER_PREFIX}${id}`;
    });
    const fragmentHtml = root2.tagName.toLowerCase() === "body" ? clone.innerHTML : clone.outerHTML;
    const markdown = htmlToMarkdown(fragmentHtml);
    return {
      kind: "webpage",
      title: document.title || location.hostname || "Captured page",
      sourceUrl: location.href,
      markdown,
      resources
    };
  }
  function selectCaptureRoot() {
    const candidates = [
      document.querySelector("article"),
      document.querySelector("main"),
      document.querySelector('[role="main"]'),
      document.body
    ].filter(Boolean);
    if (candidates.length > 0) {
      return candidates[0];
    }
    return document.documentElement;
  }
  function removeNoiseNodes(root2) {
    const selectors = [
      "script",
      "style",
      "noscript",
      "template",
      "canvas",
      "form",
      "input",
      "textarea",
      "select",
      "button",
      "object",
      "embed",
      "link",
      "meta",
      "[hidden]"
    ];
    root2.querySelectorAll(selectors.join(",")).forEach((el) => el.remove());
    root2.querySelectorAll("[aria-hidden='true']").forEach((el) => {
      if (!el.querySelector("img, video, audio, svg")) {
        el.remove();
      }
    });
  }
  function convertCanvasesToImages(root2) {
    root2.querySelectorAll("canvas").forEach((canvas) => {
      try {
        const dataUrl = canvas.toDataURL("image/png");
        if (dataUrl.length > 300) {
          const img = document.createElement("img");
          img.src = dataUrl;
          img.alt = canvas.getAttribute("aria-label") || canvas.getAttribute("title") || "Converted canvas image";
          canvas.replaceWith(img);
        }
      } catch {
      }
    });
  }
  function rewriteCapturedResources(root2, register) {
    root2.querySelectorAll("img, video, audio, a[href], iframe").forEach((node) => {
      if (!(node instanceof HTMLElement)) {
        return;
      }
      if (node.tagName === "IMG") {
        rewriteImage(node, register);
        return;
      }
      if (node.tagName === "VIDEO") {
        rewriteMediaElement(node, "video", register);
        return;
      }
      if (node.tagName === "AUDIO") {
        rewriteMediaElement(node, "audio", register);
        return;
      }
      if (node.tagName === "A") {
        rewriteAttachmentLink(node, register);
        return;
      }
      if (node.tagName === "IFRAME") {
        rewriteIframe(node);
      }
    });
    root2.querySelectorAll("picture source, video source, audio source").forEach((node) => node.remove());
  }
  function rewriteImage(node, register) {
    let url = pickImageUrl(node);
    if (!url) {
      const picture = node.closest("picture");
      if (picture) {
        url = pickPictureSourceUrl(picture);
      }
    }
    if (!url) {
      return;
    }
    const placeholder = register(url, "image", inferFilename(url, "image"));
    if (!placeholder) {
      return;
    }
    node.setAttribute("src", placeholder);
    node.removeAttribute("srcset");
    node.removeAttribute("data-srcset");
    node.removeAttribute("sizes");
    node.removeAttribute("data-src");
    node.removeAttribute("data-original");
    node.removeAttribute("data-lazy-src");
    node.removeAttribute("data-url");
  }
  function rewriteMediaElement(node, kind, register) {
    const existing = node.getAttribute("src") || "";
    const source = existing || pickSourceUrl(node);
    if (!source) {
      return;
    }
    const placeholder = register(source, kind, inferFilename(source, kind));
    if (!placeholder) {
      return;
    }
    const poster = node.getAttribute("poster");
    if (kind === "video" && poster) {
      const posterPlaceholder = register(normalizeCapturedUrl(poster), "image", inferFilename(poster, "image"));
      if (posterPlaceholder) {
        const link2 = document.createElement("a");
        link2.href = placeholder;
        const image = document.createElement("img");
        image.src = posterPlaceholder;
        image.alt = getMediaLabel(node, kind);
        link2.append(image);
        node.replaceWith(link2);
        return;
      }
    }
    const link = document.createElement("a");
    link.href = placeholder;
    link.textContent = getMediaLabel(node, kind);
    node.replaceWith(link);
  }
  function rewriteAttachmentLink(node, register) {
    const href = node.getAttribute("href") || "";
    const kind = inferKind(href);
    if (!kind) {
      return;
    }
    const placeholder = register(href, kind, inferFilename(href, kind));
    if (!placeholder) {
      return;
    }
    node.setAttribute("href", placeholder);
  }
  function rewriteIframe(node) {
    const src = node.getAttribute("src") || "";
    if (!src) {
      node.remove();
      return;
    }
    const wrapper = document.createElement("p");
    const link = document.createElement("a");
    link.href = src;
    link.textContent = "Open embedded content";
    wrapper.append("Embedded content: ");
    wrapper.append(link);
    node.replaceWith(wrapper);
  }
  function pickImageUrl(node) {
    const srcset = node.getAttribute("srcset") || node.getAttribute("data-srcset") || "";
    if (srcset) {
      const picked = pickBestFromSrcset(srcset);
      if (picked) {
        return normalizeCapturedUrl(picked) || "";
      }
    }
    const lazyAttrs = ["data-src", "data-original", "data-lazy-src", "data-url", "src"];
    for (const attr of lazyAttrs) {
      const value = node.getAttribute(attr);
      if (value && !isPlaceholder(value)) {
        return normalizeCapturedUrl(value) || "";
      }
    }
    return "";
  }
  function pickSourceUrl(node) {
    const sources = Array.from(node.querySelectorAll("source"));
    for (const source of sources) {
      const src = source.getAttribute("src") || source.getAttribute("data-src") || "";
      if (src && !isPlaceholder(src)) {
        return normalizeCapturedUrl(src) || "";
      }
      const srcset = source.getAttribute("srcset") || source.getAttribute("data-srcset") || "";
      const chosen = pickBestFromSrcset(srcset);
      if (chosen) {
        return normalizeCapturedUrl(chosen) || "";
      }
    }
    return "";
  }
  function pickPictureSourceUrl(picture) {
    const sources = Array.from(picture.querySelectorAll(":scope > source"));
    let bestUrl = "";
    let bestWidth = 0;
    for (const source of sources) {
      const src = source.getAttribute("src") || source.getAttribute("data-src") || "";
      if (src && !isPlaceholder(src)) {
        return normalizeCapturedUrl(src) || "";
      }
      const srcset = source.getAttribute("srcset") || source.getAttribute("data-srcset") || "";
      if (srcset) {
        const chosen = pickBestFromSrcset(srcset);
        if (chosen) {
          const width = estimateSrcsetMaxWidth(srcset);
          if (width > bestWidth) {
            bestWidth = width;
            bestUrl = chosen;
          }
        }
      }
    }
    return normalizeCapturedUrl(bestUrl) || "";
  }
  function estimateSrcsetMaxWidth(srcset) {
    const entries = srcset.split(",").map((entry) => entry.trim()).filter(Boolean);
    let maxWidth = 0;
    for (const entry of entries) {
      const parts = entry.split(/\s+/).filter(Boolean);
      const descriptor = parts[1] || "";
      const widthMatch = descriptor.match(/^(\d+)w$/);
      if (widthMatch) {
        maxWidth = Math.max(maxWidth, Number(widthMatch[1]));
        continue;
      }
      const densityMatch = descriptor.match(/^(\d+(?:\.\d+)?)x$/);
      if (densityMatch) {
        maxWidth = Math.max(maxWidth, Math.round(Number(densityMatch[1]) * 1e3));
      }
    }
    return maxWidth;
  }
  function pickBestFromSrcset(srcset) {
    if (!srcset) {
      return "";
    }
    const entries = srcset.split(",").map((entry) => entry.trim()).filter(Boolean);
    let bestUrl = "";
    let bestWidth = 0;
    let bestDensity = 0;
    for (const entry of entries) {
      const parts = entry.split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        continue;
      }
      const url = parts[0];
      const descriptor = parts[1] || "";
      const widthMatch = descriptor.match(/^(\d+)w$/);
      if (widthMatch) {
        const width = Number(widthMatch[1]);
        if (width > bestWidth) {
          bestWidth = width;
          bestUrl = url;
        }
        continue;
      }
      const densityMatch = descriptor.match(/^(\d+(?:\.\d+)?)x$/);
      if (densityMatch) {
        const density = Number(densityMatch[1]);
        if (density > bestDensity) {
          bestDensity = density;
          bestUrl = url;
        }
        continue;
      }
      if (!bestUrl) {
        bestUrl = url;
      }
    }
    return bestUrl;
  }
  function pickBestFigureImage(node) {
    const images = Array.from(node.querySelectorAll("img")).filter((candidate) => {
      return candidate instanceof HTMLImageElement;
    });
    let bestImage = null;
    let bestScore = -Infinity;
    for (const image of images) {
      const score = scoreFigureImage(image);
      if (score > bestScore) {
        bestScore = score;
        bestImage = image;
      }
    }
    return bestImage;
  }
  function scoreFigureImage(image) {
    const width = parsePositiveDimension(image.getAttribute("width")) || estimateSrcsetWidth(image);
    const height = parsePositiveDimension(image.getAttribute("height"));
    let score = 0;
    if (width && height) {
      score = width * height;
    } else if (width) {
      score = width;
    } else if (height) {
      score = height;
    } else {
      score = 1;
    }
    const hint = `${image.getAttribute("alt") || ""} ${image.getAttribute("title") || ""}`.toLowerCase();
    if (/\bavatar\b|\bprofile\b|\bicon\b|\blogo\b|\bthumbnail\b/.test(hint)) {
      score *= 0.1;
    }
    if (image.closest("figcaption")) {
      score *= 0.25;
    }
    if (image.hasAttribute("hidden") || image.getAttribute("aria-hidden") === "true") {
      score *= 0.5;
    }
    return score;
  }
  function parsePositiveDimension(value) {
    if (!value) {
      return 0;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  function estimateSrcsetWidth(image) {
    const srcset = image.getAttribute("srcset") || image.getAttribute("data-srcset") || "";
    if (!srcset) {
      return 0;
    }
    const entries = srcset.split(",").map((entry) => entry.trim()).filter(Boolean);
    let bestWidth = 0;
    for (const entry of entries) {
      const parts = entry.split(/\s+/);
      const descriptor = parts[1] || "";
      const widthMatch = descriptor.match(/^(\d+)w$/);
      if (widthMatch) {
        bestWidth = Math.max(bestWidth, Number(widthMatch[1]));
        continue;
      }
      const densityMatch = descriptor.match(/^(\d+(?:\.\d+)?)x$/);
      if (densityMatch && bestWidth === 0) {
        bestWidth = Math.max(bestWidth, Math.round(Number(densityMatch[1]) * 1e3));
      }
    }
    return bestWidth;
  }
  function resolveUrl(value) {
    try {
      return new URL(value, location.href).href;
    } catch {
      return value.trim();
    }
  }
  function normalizeCapturedUrl(value) {
    return normalizeMediaReference(resolveUrl(value));
  }
  function isIgnoredScheme(value) {
    const lower = value.trim().toLowerCase();
    return !lower || lower.startsWith("javascript:") || lower.startsWith("mailto:") || lower.startsWith("tel:") || lower.startsWith("data:");
  }
  function isPlaceholder(value) {
    return value.startsWith(PLACEHOLDER_PREFIX);
  }
  function inferKind(url) {
    const ext = getExtension(url);
    if (IMAGE_EXTS.has(ext))
      return "image";
    if (VIDEO_EXTS.has(ext))
      return "video";
    if (AUDIO_EXTS.has(ext))
      return "audio";
    if (ATTACHMENT_EXTS.has(ext))
      return "attachment";
    return null;
  }
  function inferFilename(url, kind) {
    let base = "resource";
    try {
      const parsed = new URL(url, location.href);
      const decodedPath = decodeURIComponent(parsed.pathname);
      base = decodedPath.split("/").filter(Boolean).pop() || base;
    } catch {
      try {
        const decodedUrl = decodeURIComponent(url);
        base = decodedUrl.split("/").filter(Boolean).pop() || base;
      } catch {
        base = url.split("/").filter(Boolean).pop() || base;
      }
    }
    base = base.split("?")[0].split("#")[0];
    base = stripSyntheticMediaVariantSuffix(base);
    if (!pathHasExtension(base)) {
      base += defaultExtension(kind);
    }
    return base || `resource${defaultExtension(kind)}`;
  }
  function uniqueFilename(name, resources) {
    const used = new Set(resources.map((resource) => resource.filename));
    if (!used.has(name)) {
      return name;
    }
    const ext = name.includes(".") ? `.${name.split(".").pop()}` : "";
    const stem = ext ? name.slice(0, -ext.length) : name;
    let i = 2;
    while (true) {
      const candidate = `${stem}_${i}${ext}`;
      if (!used.has(candidate)) {
        return candidate;
      }
      i += 1;
    }
  }
  function pathHasExtension(name) {
    return /\.[a-z0-9]+$/i.test(name);
  }
  function defaultExtension(kind) {
    if (kind === "image")
      return ".png";
    if (kind === "video")
      return ".mp4";
    if (kind === "audio")
      return ".mp3";
    return ".bin";
  }
  function getExtension(url) {
    try {
      const pathname = stripSyntheticMediaVariantSuffix(new URL(url, location.href).pathname.toLowerCase());
      const dot = pathname.lastIndexOf(".");
      return dot >= 0 ? pathname.slice(dot) : "";
    } catch {
      const clean = stripSyntheticMediaVariantSuffix(url.toLowerCase());
      const dot = clean.lastIndexOf(".");
      return dot >= 0 ? clean.slice(dot) : "";
    }
  }
  function guessMime(name) {
    const ext = getExtension(name);
    const table = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".bmp": "image/bmp",
      ".tiff": "image/tiff",
      ".tif": "image/tiff",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".mov": "video/quicktime",
      ".m4v": "video/x-m4v",
      ".avi": "video/x-msvideo",
      ".mkv": "video/x-matroska",
      ".ogv": "video/ogg",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".ogg": "audio/ogg",
      ".m4a": "audio/mp4",
      ".flac": "audio/flac",
      ".aac": "audio/aac",
      ".pdf": "application/pdf",
      ".csv": "text/csv",
      ".json": "application/json",
      ".txt": "text/plain",
      ".md": "text/markdown"
    };
    return table[ext] || "application/octet-stream";
  }
  function getMediaLabel(node, kind) {
    return node.getAttribute("aria-label") || node.getAttribute("title") || node.getAttribute("data-title") || node.getAttribute("alt") || (kind === "video" ? "Video" : "Audio");
  }
  function htmlToMarkdown(html) {
    const turndownService = new TurndownService({
      headingStyle: "atx",
      hr: "---",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      emDelimiter: "*"
    });
    turndownService.addRule("button", {
      filter: "button",
      replacement: (content) => content
    });
    turndownService.addRule("figure", {
      filter: "figure",
      replacement: (content, node) => {
        if (!isGenericElement(node)) {
          return content;
        }
        const img = pickBestFigureImage(node);
        if (!(img instanceof HTMLImageElement)) {
          return content;
        }
        const hasParagraphsOutsideFigcaption = Array.from(node.querySelectorAll("p")).some((paragraph) => {
          let ancestor = paragraph.parentElement;
          while (ancestor && ancestor !== node) {
            if (ancestor.nodeName === "FIGCAPTION") {
              return false;
            }
            ancestor = ancestor.parentElement;
          }
          return true;
        });
        if (hasParagraphsOutsideFigcaption) {
          return content;
        }
        const alt = img.getAttribute("alt") || "";
        const src = pickImageUrl(img);
        if (!src) {
          return content;
        }
        const figcaption = node.querySelector("figcaption");
        const caption = figcaption ? turndownService.turndown(figcaption.outerHTML).trim() : "";
        return caption ? `![${alt}](${src})

${caption}

` : `![${alt}](${src})

`;
      }
    });
    turndownService.addRule("linkedMedia", {
      filter: (node) => {
        if (!isGenericElement(node) || node.nodeName !== "A") {
          return false;
        }
        return isSingleMediaAnchor(node);
      },
      replacement: (content) => content.trim()
    });
    const markdown = turndownService.turndown(html);
    return collapseLinkedMediaWrappers(markdown);
  }
  function isSingleMediaAnchor(node) {
    let mediaCount = 0;
    for (const child of Array.from(node.childNodes || [])) {
      if (child.nodeType === Node.TEXT_NODE) {
        if ((child.textContent || "").trim()) {
          return false;
        }
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }
      const element = child;
      if (element.nodeName === "IMG" || element.nodeName === "VIDEO" || element.nodeName === "AUDIO") {
        mediaCount += 1;
        continue;
      }
      if (element.nodeName === "PICTURE" && element.querySelector("img")) {
        mediaCount += 1;
        continue;
      }
      if (element.getAttribute("aria-hidden") === "true" || element.hasAttribute("hidden")) {
        continue;
      }
      if (!(element.textContent || "").trim()) {
        continue;
      }
      return false;
    }
    return mediaCount === 1;
  }
})();
//# sourceMappingURL=content.js.map

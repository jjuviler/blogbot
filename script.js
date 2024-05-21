function runBlogbot() {
  var fadeTime = 300;

  $('#source-code-area').fadeOut(fadeTime, 'linear', function() {
    var bodyText = $("#source-code-area").val();

    // modify source code
    if ($("#checkbox-1").is(":checked")) { bodyText = addReadMoreTag(bodyText); }
    if ($("#checkbox-2").is(":checked")) { bodyText = clearSpanTags(bodyText); }
    if ($("#checkbox-3").is(":checked")) { bodyText = clearStyleAttributes(bodyText); }
    if ($("#checkbox-4").is(":checked")) { bodyText = clearEmptyLines(bodyText); }
    if ($("#checkbox-5").is(":checked")) { bodyText = replaceNbsp(bodyText); }
    if ($("#checkbox-6").is(":checked")) { bodyText = openLinksInNewTab(bodyText); }
    if ($("#checkbox-7").is(":checked")) { bodyText = convertToSmartQuotes(bodyText); }
    if ($("#checkbox-8").is(":checked")) { bodyText = formatImages(bodyText); }
                    console.log(bodyText);

    if ($("#checkbox-9").is(":checked")) { bodyText = formatImageSource(bodyText); }
    if ($("#checkbox-10").is(":checked")) { bodyText = addAltText(bodyText); }
    if ($("#checkbox-11").is(":checked")) { bodyText = removeImgName(bodyText); }
    if ($("#checkbox-18").is(":checked")) { bodyText = addAnchors(bodyText); }


    // check for formatting/style issues and flag them to user
    var warningMessages = [];
    if ($("#checkbox-12").is(":checked") && checkHeadingHierarchy(bodyText)) { warningMessages.push("Headings may be out of order. Check to make sure that h3s only follow h2s or h3, etc.") }
    if ($("#checkbox-13").is(":checked") && containsDoubleDash(bodyText)) { warningMessages.push("Replace all double-dashes (--) with em dashes."); }
    if ($("#checkbox-14").is(":checked") && checkEllipses(bodyText)) { warningMessages.push("Make sure all ellipses have a space on both sides."); }
    if ($("#checkbox-15").is(":checked") && checkVersusVs(bodyText)) { warningMessages.push('Make sure "vs." is only used in headings and "versus" is only used in paragraphs.') }
    if ($("#checkbox-16").is(":checked") && checkQueryStrings(bodyText)) { warningMessages.push('Remove tracking parameters from all URLs.') }

    // featured snippets
    if ($("#checkbox-17").is(":checked")) { bodyText = createFeaturedSnippets(bodyText); }


    // remove any blank spaces in the modified code output
    bodyText = removeEmptyOutputLines(bodyText);

    // put modified code into text area
    $("#source-code-area").val(bodyText);

    // put warning messages into text area
    var warningOutput = "";
    for (let i=0; i<warningMessages.length; i++) { warningOutput += 'Issue: ' + warningMessages[i] + '\n\n'; }
    $("#warning-area").val(warningOutput);
  });

  $('#source-code-area').fadeIn(fadeTime, 'linear');
}

// copies the current text from the source code textarea to clipboard
function copyCode() {
  const copyText = $("#source-code-area");
  copyText.select();
  navigator.clipboard.writeText(copyText.val());
}

// clears the source code textarea
function clearCode() { $('textarea').val(''); }

// =====================================================
// ================= Feature Functions =================
// =====================================================

// removes all span tags from the source code
function clearSpanTags(htmlString) {
  return htmlString.replace(/<\/?span[^>]*>/g, '');
}

// clears the style attribute from all HTML tags
function clearStyleAttributes(htmlString) {
  const cleanedHtml = htmlString.replace(/<(?!\/?table\b)[^>]*>/g, match =>
    match.replace(/\s*style\s*=\s*(['"])(?:(?!\1)[^\\]|\\.)*\1/g, '')
  );
  return cleanedHtml;
}

function clearEmptyLines(htmlString) {
  const regex = /<p[^>]*>(?:&nbsp;|\s)*<\/p>/g;
  return htmlString.replace(regex, '');
}

// sets all images to 650px wide and centers all images
function formatImages(htmlString) {
  const regexStr = /<img((?:(?!src)[^>])*src="[^"]*")(?:[^>]*)>/gi;
  const replacement = '<img$1 style="margin-left: auto; margin-right: auto; display: block; width: 650px; height: auto; max-width: 100%;" title="" loading="lazy">';
  return htmlString.replace(regexStr, replacement);
}

// formats the image source link below an image
function formatImageSource(htmlString) {

  // italisize each instance of "Image Source" and capitalize the first letter of both words
  var regex = /(<em>)?image source(<\/em>)?/gi;
  htmlString = htmlString.replace(regex, function(match, p1, p2) {
    if (p1 && p2) {
      // Already wrapped in <em> tags
      return '<em>Image Source</em>';
    } else {
      // Not wrapped in <em> tags
      return '<em>Image Source</em>';
    }
  });

  // centers the image source link and makes the font size 12
  regex = /(<p[^>]*>\s*.*Image Source.*\s*<\/p>)/gi;
  const matches = htmlString.match(regex);
  if (matches) {
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const parentParagraphRegex = /<p[^>]*>/i;
      const parentParagraphMatch = match.match(parentParagraphRegex);
      if (parentParagraphMatch) {
        const parentParagraph = parentParagraphMatch[0];
        const newParentParagraph = parentParagraph.replace(">", ' style="text-align: center; font-size: 12px;">');
        const newMatch = match.replace(parentParagraph, newParentParagraph);
        htmlString = htmlString.replace(match, newMatch);
      }
    }
  }
  return htmlString;
}

// replaces allo instances of "&nbsp;" with " "
function replaceNbsp(htmlString) {
  return htmlString.replace(/&nbsp;/g, ' ');
}

// sets all non-anchor links to open in a new tab (along with adding a rel=noopener attribute) 
function openLinksInNewTab(htmlString) {
  const pattern = /<a\s+(?:[^>]*?\s+)?href="((?:https?:\/\/)[^"]+)"/gi;
  const replacement = '<a href="$1" rel="noopener" target="_blank"';
  return htmlString.replace(pattern, replacement);
}

// checks if there is a read more tag in the post. if not, adds a read more tag after the first paragraph
function addReadMoreTag(htmlString) {
  // Check if "<!--more-->" is already present. if so, return original string
  if (htmlString.includes("<!--more-->")) { return htmlString; }

  // Find the first paragraph closing tag and add "<!--more-->" after the closing tag
  var closingTagIndex = htmlString.indexOf("</p>");
  if (closingTagIndex !== -1) {
    closingTagIndex += 4;
    const newHtmlString = htmlString.slice(0, closingTagIndex) + "\n<!--more-->" + htmlString.slice(closingTagIndex);
    return newHtmlString;
  } else {
    // If no paragraph is found, return original string.
    return htmlString;
  }
}

// checks that heading tags are in the correct order (h3s only follow h2s or h3s, etc.)
function checkHeadingHierarchy(htmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");

  const headings = doc.querySelectorAll("h2, h3, h4, h5, h6");

  if (headings.length == 0) { return false; }

  let prevHeadingLevel = parseInt(headings[0].tagName.charAt(1));
  for (let i = 0; i < headings.length; i++) {
    const currHeadingLevel = parseInt(headings[i].tagName.charAt(1));
    if (currHeadingLevel === prevHeadingLevel + 1) {
      prevHeadingLevel = currHeadingLevel;
    } else if (currHeadingLevel <= prevHeadingLevel) {
      prevHeadingLevel = currHeadingLevel;

    } else {
      return true;
    }
  }

  return false;
}

function convertToSmartQuotes(htmlString) {
  // Create a regular expression to match straight quotes
  var straightQuotesRegex = /("([^"]|\\")*")|('([^']|\\')*')/g;

  // Split the HTML string into segments that are inside and outside of HTML tags
  var segments = htmlString.split(/(<\/?[^>]+>)/);

  // Define mapping for straight quotes to smart quotes
  var smartQuotesMap = {
    '"': {
      opening: '“',
      closing: '”'
    },
    "'": {
      opening: '‘',
      closing: '’'
    }
  };

  // Iterate through the segments and convert straight quotes to smart quotes
  for (var i = 0; i < segments.length; i++) {
    // Check if the segment is not inside an HTML tag
    if (!/<\/?[a-z][\s\S]*>|<[^<>]*>|{[^{}]*}/i.test(segments[i])) {
      segments[i] = segments[i].replace(straightQuotesRegex, function(match) {
        // Get the appropriate smart quote based on the straight quote type
        var quoteType = match.charAt(0);
        var smartQuote = smartQuotesMap[quoteType];
        return smartQuote ? smartQuote.opening + match.slice(1, -1) + smartQuote.closing : match;
      });
    }
  }

  // Join the segments back together and return the modified HTML string
  return segments.join('');
}


// looks for alt text written below images and adds it to the preceeding image's alt text attribute
function addAltText(htmlCode) {
  const regex = /.*(?:alt|alt text):\s*(.*)/gi; // Matches lines with "alt" or "alt text" and captures the text after it
  const lines = htmlCode.split('\n'); // Splits the HTML code into lines
  const tagRegex = /<[^>]*>/g; // Matches HTML tags

  for (let i = 0; i < lines.length; i++) {
    const match = regex.exec(lines[i]); // Checks if the line matches the alt text pattern
    if (match) {
      const lineWithoutAlt = match[1]; // Extracts the alt text
      const lineWithoutTags = lineWithoutAlt.replace(tagRegex, ''); // Removes HTML tags from the alt text

      // Find the closest previous image tag
      let j = i - 1;
      while (j >= 0 && !lines[j].includes('<img')) { // Searches for the previous line with an <img> tag
        j--;
      }

      if (j >= 0) {
        const imgMatch = lines[j].match(/<img[^>]*>/); // Matches the <img> tag
        if (imgMatch) {
          let imgTag = imgMatch[0];
          if (imgTag.includes('alt="')) {
            // Updates the existing alt attribute
            imgTag = imgTag.replace(/alt="([^"]*)"/, `alt="${lineWithoutTags}"`);
          } else {
            // Adds a new alt attribute at the end of the <img> tag
            imgTag = imgTag.replace(/<img([^>]*)>/, `<img$1 alt="${lineWithoutTags}">`);
          }
          const newLine = lines[j].replace(imgMatch[0], imgTag);

          // Updates the line with the modified <img> tag
          lines[j] = newLine;
        }
      }

      // Deletes the line containing the alt text instruction
      lines.splice(i, 1);
      i--;
    }
  }

  return lines.join('\n'); // Joins the lines back into a single string and returns it
}

// checks for double dash (--) characters
function containsDoubleDash(htmlString) {
  let insideAngleBrackets = false;
  for (let i = 0; i < htmlString.length; i++) {
    const currentChar = htmlString[i];
    if (currentChar === "<") {
      insideAngleBrackets = true;
    } else if (currentChar === ">") {
      insideAngleBrackets = false;
    } else if (!insideAngleBrackets && currentChar === "-" && htmlString[i + 1] === "-") {
      return true;
    }
  }
  return false;
}

// checks for ellipses that do not have a space on both sides
function checkEllipses(htmlString) {
  const regex = /(?<=\w)\.{3}|(?=\.{3}\w)/g;
  return regex.test(htmlString);
}

// checks for "versus" in headings or "vs." in paragraphs
function checkVersusVs(htmlString) {
  const regex = /<p[^>]*>(?:(?!<\/p>)[\s\S])*vs\.(?:(?!<\/p>)[\s\S])*<\/p>|<(h[2-6])[^>]*>(?:(?:(?!<\/\1>)[\s\S])*versus(?:(?!<\/\1>)[\s\S])*)<\/\1>/i;
  return regex.test(htmlString);
}

// searches for instances of "img name" or "image name" (case-insensitive) and deletes the entire line if found
function removeImgName(htmlString) {
  const regex = /^(?=.*\b(img|image)\s+name\b).*$/gim;
  return htmlString.replace(regex, '');
}

// check for instances of "?" in URLs, with the exception of youtube URLs
function checkQueryStrings(htmlString) {
  const regex = /<a[^>]*href="((?!https:\/\/www\.youtube\.com\/watch)[^"]*\?[^"]*)"[^>]*>/g;
  return regex.test(htmlString);
}

// removes empty lines from Blogbot output
function removeEmptyOutputLines(htmlString) {
  const lines = htmlString.split(/\r?\n/);
  const nonEmptyLines = lines.filter(line => line.trim() !== '');
  const updatedHTML = nonEmptyLines.join('\n');
  return updatedHTML;
}

// add featured snippet code to the body of the post
function createFeaturedSnippets(htmlString) {

  // remove extra whitespaces around all instances of [fs] and [/fs]
  const fsStartRegex = /<p>\s*\[fs\]\s*<\/p>/gi;
  const fsEndRegex = /<p>\s*\[\/fs\]\s*<\/p>/gi;
  htmlString = htmlString.replace(fsStartRegex, '<p>[fs]</p>').replace(fsEndRegex, '<p>[/fs]</p>');

  // find all instances of "<p>[fs]</p>" in the html string
  const fsRegex = /<p>\s*\[fs\]\s*<\/p>/gi;
  const fsMatches = [...htmlString.matchAll(fsRegex)];
  var fsCodes = [];

  // return if no instances of [fs] are found
  if (fsMatches.length === 0) { return htmlString; }

  console.log(fsMatches);

  // for each instance of [fs] in htmlString
  for (const fsMatch of fsMatches) {
    const fsStartIndex = fsMatch.index;
    const fsEndIndex = htmlString.indexOf('<p>[/fs]</p>', fsStartIndex);

    // Skip this [fs] if there's no corresponding [/fs]
    if (fsEndIndex === -1) { continue; }

    // Create array of all list items; paragraph snippets only have 2 list items (because the first is the heading)
    var replacedString = htmlString.substring(fsStartIndex, fsEndIndex + 12);
    var itemsBetweenFs = replacedString.replace(/<\/?[^>]+(>|$)/g, "");
    var itemsBetweenFs = itemsBetweenFs.substring(5, itemsBetweenFs.length - 6);
    const listItems = itemsBetweenFs.split('\n').filter(item => item !== '');

    // determine if FS is paragraph snippet or list snippet
    var isList = true;
    if (listItems.length < 2) { continue; }
    if (listItems.length < 3) { isList = false; }

    // create the snippet code
    var fsCode = '';
    if (isList) { fsCode = createFsListCode(listItems); }
    else { fsCode = createFsParagraphCode(listItems); }
    
    // add the fsCode string and the replacedString to an array, fsCodes
    fsCodes.push([replacedString, fsCode]);
  }

  // replace all instances off <p>[fs]...[/fs]</p> with the corresponding featured snippet code
  for (let i=0; i<fsCodes.length; i++) {
    htmlString = htmlString.replace(fsCodes[i][0], fsCodes[i][1]);
  }

  return htmlString;
}

// creates paragraph featured snippet code
function createFsParagraphCode(items) {
  return '{{ sgMacro.render_ftSnippet({ header: "' + items[0] + '", content_type: "paragraph", list: { items : [ "" ] }, paragraph: { content: "' + items[1] + '" } }) }}';
}

// creates list featured snippet code
function createFsListCode(items) {
  var itemsStr = '';
  for (let i = 1; i < items.length; i++) {
    itemsStr += '"' + items[i] + '"';
    if (i != items.length - 1) { itemsStr += ', '; }
  }

  return '{{ sgMacro.render_ftSnippet({ header: "' + items[0] + '", content_type: "ordered_list", list: { items : [ ' + itemsStr + ' ] }, paragraph: { content: "" } }) }}';
}


// adds anchor code above H2s and feature snippet code, using the contents of the heading as the id
function addAnchors(htmlString) {
  // Split the HTML string into an array of substrings based on line breaks
  const lines = htmlString.split('\n');
  const modifiedLines = [];

  // Iterate through the lines and find <h2> tags
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // If the line contains an <h2> tag, add an anchor element in the line before
    if (line.includes('<h2>')) {
      // Extract the content within <h2> tags
      const h2Content = line.match(/<h2>(.*?)<\/h2>/)[1];

      // Create the anchor element
      var anchor = h2Content
        .replace(/<\/?[^>]+(>|$)/g, "") // Remove HTML tags and their content
        .replace(/\s+/g, '-')           // Replace one or more spaces with hyphens
        .replace(/[^a-zA-Z0-9-]+/g, '') // Remove any characters that are not letters, numbers, or hyphens
        .replace(/--+/g, '-')           // Replace more than one hyphen with a single hyphen
        .replace(/^-+|-+$/g, '')        // Remove both leading and trailing hyphens
        .toLowerCase();                 // Convert the resulting string to lowercase
      anchor = '<a id="' + anchor + '" data-hs-anchor="true"></a>';

      // Insert the wrapped content as a new element in the modified array
      modifiedLines.push(anchor);
    }

    // If the line is featured snippet code, add an anchor element in the line before
    else if (line.includes('ftSnippet')) {
      // Extract the value between the first pair of quotes
      const match = line.match(/"([^"]+)"/);
      const h2Content = match ? match[1] : '';

      // Create the anchor element
      var anchor = h2Content.replace(/<\/?[^>]+(>|$)/g, "").replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]+/g, '').toLowerCase();
      anchor = '<a id="' + anchor + '" data-hs-anchor="true"></a>';

      // Insert the wrapped content as a new element in the modified array
      modifiedLines.push(anchor);
    }

    // Push the original line to the modified array
    modifiedLines.push(line);
  }

  // Join the modified array of lines into a single HTML string
  return modifiedLines.join('\n');
}

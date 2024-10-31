
function extractAnchorTags(htmlString) {

    // Regular expression to match the opening <a> tag, its content, and the closing </a> tag
    const anchorRegex = /<a\s[^>]*>.*?<\/a>/gi;

    // Extract all anchor tags from the input HTML string
    const anchorTags = htmlString.match(anchorRegex) || [];

    // Function to remove whitespace outside tags and return the modified string along with a boolean indicating if whitespace was removed
    function removeWhitespaceOutsideTags(substring) {
        let result = '';
        let insideTag = false;
        let whitespaceRemoved = false;

        // Iterate over the substring and remove whitespace outside tags
        for (let i = 0; i < substring.length; i++) {
            const char = substring[i];

            if (char === '<') {
                insideTag = true;
            }
            if (char === '>') {
                insideTag = false;
                result += char;  // Add the closing tag character
                continue;
            }

            // If inside a tag or the character is not whitespace, add it
            if (insideTag || !/\s/.test(char)) {
                result += char;
            } else {
                whitespaceRemoved = true;
            }
        }

        return { result, whitespaceRemoved };
    }

    // Process each anchor tag and create substrings
    const processedTags = anchorTags.map(anchor => {
        const originalString = anchor;  // Save the original unmodified anchor string

        const openingTagMatch = anchor.match(/<a\s[^>]*>/i);  // Match the opening tag
        const closingTagMatch = anchor.match(/<\/a>/i);  // Match the closing tag

        // Get the content between the opening and closing <a> tag
        const content = anchor.replace(openingTagMatch[0], '').replace(closingTagMatch[0], '');

        // ---------- FIRST SUBSTRING CREATION ----------
        let firstSubstring = '';  // Initialize the first substring
        let firstStart = openingTagMatch[0].length;  // Start index of the first substring
        let firstEnd = firstStart;  // End index will be updated during iteration

        let insideTag = false;    // Track whether we're inside an HTML tag

        for (let i = 0; i < content.length; i++) {
            const char = content[i];

            if (char === '<') {
                insideTag = true;
            }
            if (char === '>') {
                insideTag = false;
                firstSubstring += char;  // Add the closing tag character
                firstEnd = firstStart + firstSubstring.length;  // Update end index
                continue;
            }

            // If inside a tag, add the character and continue
            if (insideTag) {
                firstSubstring += char;
                firstEnd = firstStart + firstSubstring.length;  // Update end index
                continue;
            }

            // If we encounter a non-whitespace character outside of a tag, stop
            if (!/\s/.test(char)) {
                break;
            }

            // Add whitespace outside of tags to the substring
            firstSubstring += char;
            firstEnd = firstStart + firstSubstring.length;  // Update end index
        }

        // Remove whitespace outside of tags from first substring
        const { result: firstSubstringNOWS, whitespaceRemoved: firstWhitespaceRemoved } = removeWhitespaceOutsideTags(firstSubstring);

        // ---------- Replace characters in the modifiedString with firstSubstringNOWS ----------
        if (firstStart !== firstEnd) {
            // Replace characters between firstStart and firstEnd with firstSubstringNOWS
            anchor = anchor.slice(0, firstStart) + firstSubstringNOWS + anchor.slice(firstEnd);

            // If firstWhitespaceRemoved is true, add a space before the opening <a> tag
            if (firstWhitespaceRemoved) {
                anchor = ' ' + anchor;
            }
        }

        // At this point, we are now working with the **modified** anchor string
        const modifiedContent = anchor.replace(openingTagMatch[0], '').replace(closingTagMatch[0], '');

        // ---------- SECOND SUBSTRING CREATION (based on modified content) ----------
        let secondSubstring = '';  // Initialize the second substring
        let secondEnd = modifiedContent.length + openingTagMatch[0].length;  // End index
        let secondStart = secondEnd;  // Start index will be updated during iteration

        insideTag = false;  // Reset tracking for second substring

        // Iterate backward from the last character just before the closing </a> tag
        for (let i = modifiedContent.length - 1; i >= 0; i--) {
            const char = modifiedContent[i];

            // If we hit a '>', we are inside a tag
            if (char === '>') {
                insideTag = true;
                secondSubstring = char + secondSubstring;  // Add '>' to the front
                secondStart--;  // Update start index
                continue;
            }

            // If we are inside a tag, add everything until we find '<'
            if (insideTag) {
                secondSubstring = char + secondSubstring;  // Add the character to the front
                secondStart--;  // Update start index
                if (char === '<') {
                    insideTag = false;
                }
                continue;
            }

            // If the character is a whitespace, add it to the front of the second substring
            if (/\s/.test(char)) {
                secondSubstring = char + secondSubstring;
                secondStart--;  // Update start index
            } else {
                // If we hit a non-whitespace character, stop. Do not include this character.
                break;
            }
        }

        // Remove whitespace outside of tags from second substring
        const { result: secondSubstringNOWS, whitespaceRemoved: secondWhitespaceRemoved } = removeWhitespaceOutsideTags(secondSubstring);

        // ---------- Replace characters in the anchor with secondSubstringNOWS ----------
        if (secondStart !== secondEnd) {
            // Replace characters between secondStart and secondEnd with secondSubstringNOWS
            anchor = anchor.slice(0, secondStart) + secondSubstringNOWS + anchor.slice(secondEnd);

            // If secondWhitespaceRemoved is true, add a space after the closing </a> tag
            if (secondWhitespaceRemoved) {
                anchor = anchor + ' ';
            }
        }

        // Ensure the closing </a> tag is not affected by slicing
        anchor = anchor.replace(/<\/a>$/, '</a>');

        // Return the array object with all data, including originalString and whitespace removal status
        return {
            originalString: originalString,  // Original anchor string before modification
            modifiedString: anchor,  // Updated modifiedString with firstSubstringNOWS/secondSubstringNOWS replacement

            firstSubstring: firstSubstring,  // Substring starting after the opening tag
            firstSubstringIndex: { start: firstStart, end: firstEnd },  // Indices for first substring
            firstSubstringNOWS: firstSubstringNOWS,  // First substring without unnecessary whitespace
            firstWhitespaceRemoved: firstWhitespaceRemoved, // Boolean indicating if whitespace was removed from the first substring

            secondSubstring: secondSubstring,  // Substring created by iterating backwards
            secondSubstringIndex: { start: secondStart, end: secondEnd },  // Indices for second substring
            secondSubstringNOWS: secondSubstringNOWS,  // Second substring without unnecessary whitespace
            secondWhitespaceRemoved: secondWhitespaceRemoved // Boolean indicating if whitespace was removed from the second substring
        };
    });

    // Replace original anchor strings in the htmlString with their corresponding modifiedString
    processedTags.forEach(item => {
        htmlString = htmlString.replace(item.originalString, item.modifiedString);
    });

    // Return the final modified HTML string
    return htmlString;
}

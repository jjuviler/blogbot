// frontend.js

$(document).ready(function() {
	// enables/disables month/year selection for editor's note
    $('#addEditorsNote').change(function() {
        var isEnabled = $(this).is(':checked');
        $('#monthSelect').prop('disabled', !isEnabled);
        $('#yearSelect').prop('disabled', !isEnabled);
    });

    // Initially disable the drop area
    $('#drop-area').css('opacity', '0.3').find('input, label').prop('disabled', true);

    // Function to check the text input and enable/disable the drop area
    $('#primaryKeyword').on('input', function() {
        var inputText = $(this).val().trim();
        if (inputText.length > 0) {
            $('#drop-area').css('opacity', '1').find('input, label').prop('disabled', false);
        } else {
            $('#drop-area').css('opacity', '0.3').find('input, label').prop('disabled', true);
        }
    });

    // make primary KW textarea glow if user tries to drag in a file without adding a primary KW
    function handleDragEvent() {
        var inputText = $('#primaryKeyword').val().trim();
        if (inputText.length === 0) {
            $('#primaryKeyword').addClass('glow');
        }
    }

    function removeGlowEffect() {
        $('#primaryKeyword').removeClass('glow');
    }

    // Attach dragover and dragleave event handlers
    $('#drop-area').on('dragover', handleDragEvent);
    $('#drop-area').on('dragleave drop', removeGlowEffect);


    // reveal advanced options when clicked
    let advancedOptionsOpen = false;
    $('#advanced-options-toggle').click(function() {
        $('#advanced-options-content').toggle(); // This toggles the visibility
        advancedOptionsOpen = !advancedOptionsOpen;
        $('.arrow').toggleClass('up', advancedOptionsOpen);
    });

    // select/deselect all advanced options checkboxes
    $('#selectAll').click(function(event) {
        event.preventDefault(); // Prevent default form submission behavior
        $('#advanced-options-content input[type="checkbox"]').prop('checked', true);
    });

    $('#deselectAll').click(function(event) {
        event.preventDefault(); // Prevent default form submission behavior
        $('#advanced-options-content input[type="checkbox"]').prop('checked', false);
    });

    // open full upload instructions
    $('#uploadInstructionsButton').click(function() {
        window.open('https://docs.google.com/document/d/1X3wBu7VI9ad1Tk4JxlhwYFFJQOra92TcgcZzTz8Ircg/edit?usp=sharing', '_blank');
    });

    // hides the issues box when the close button is clicked
    $('#closeButton').click(function() {
        $('#issueBox').hide();
    });

    // put checklist in the checklist text area
    addChecklistContent();
});

function refreshChecklist() {
    $("#checklist").val("");
    addChecklistContent();
}

function copyChecklist() {
    const copyText = $("#checklist");
    copyText.select();
    navigator.clipboard.writeText(copyText.val());
}

function copyHTML() {
    const copyText = $("#fileContents");
    copyText.select();
    navigator.clipboard.writeText(copyText.val());
}

function addChecklistContent() {
    var checklistContent = 

`Prepare the Google Doc
    - Do a final spelling/grammar check
    - Add alt text
    - Add image sources
    - Add featured snippets
    - Create a featured image

Import the post through Blogbot
    - (NNPs only) Create a new post in HubSpot
    - (Updates only) Open the live post in HubSpot
    - Run the post through Blogbot

Complete the post settings
    - Write a title
    - (NNPs only) Add the URL slug
    - Choose the author
    - (NNPs only) Choose the cluster
    - Select the featured image
    - Write the featured image alt text
    - Write a meta description
    - Choose the campaign

Add CTAs
    - Add the Anchor CTA
    - Add the Sticky CTA
    - Add FWCTAs, including one FWCTA at the bottom of the post

Add media
    - Add videos
    - Add audio

Pillars only
    - Add the author CTA
    - Add a chapter module

Complete the Asana card
    - Do a final scan
    - Add email details
    - Add email images
    - Mark the card ready for publishing
`;

    $('#checklist').val(checklistContent);
}

/**
 * Auto-generating Table of Contents with scroll highlighting
 */
(function() {
    'use strict';

    // Wait for DOM
    document.addEventListener('DOMContentLoaded', function() {
        const sidebar = document.querySelector('.toc-sidebar');
        const content = document.querySelector('.page-content');

        if (!sidebar || !content) return;

        // Find all h2 and h3 headings in content
        const headings = content.querySelectorAll('h2, h3');
        if (headings.length === 0) return;

        // Build TOC
        const tocList = document.createElement('ul');
        tocList.className = 'toc-list';

        headings.forEach(function(heading, index) {
            // Ensure heading has an id
            if (!heading.id) {
                heading.id = 'section-' + index;
            }

            const li = document.createElement('li');
            const a = document.createElement('a');
            a.href = '#' + heading.id;
            a.textContent = heading.textContent;
            a.className = heading.tagName === 'H3' ? 'toc-h3' : '';

            li.appendChild(a);
            tocList.appendChild(li);
        });

        // Clear sidebar and add title + list
        sidebar.innerHTML = '<div class="toc-title">On This Page</div>';
        sidebar.appendChild(tocList);

        // Scroll highlighting
        const tocLinks = tocList.querySelectorAll('a');

        function highlightToc() {
            let current = '';
            const scrollPos = window.scrollY + 120;

            headings.forEach(function(heading) {
                if (heading.offsetTop <= scrollPos) {
                    current = heading.id;
                }
            });

            tocLinks.forEach(function(link) {
                link.classList.remove('active');
                if (link.getAttribute('href') === '#' + current) {
                    link.classList.add('active');
                }
            });
        }

        // Throttle scroll handler
        let ticking = false;
        window.addEventListener('scroll', function() {
            if (!ticking) {
                window.requestAnimationFrame(function() {
                    highlightToc();
                    ticking = false;
                });
                ticking = true;
            }
        });

        // Initial highlight
        highlightToc();

        // Smooth scroll on click
        tocLinks.forEach(function(link) {
            link.addEventListener('click', function(e) {
                e.preventDefault();
                const targetId = this.getAttribute('href').slice(1);
                const target = document.getElementById(targetId);
                if (target) {
                    window.scrollTo({
                        top: target.offsetTop - 80,
                        behavior: 'smooth'
                    });
                    history.pushState(null, null, '#' + targetId);
                }
            });
        });
    });
})();

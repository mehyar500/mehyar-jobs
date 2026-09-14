-- 0015_product_slots.sql
-- Replace the generic offer-slot taxonomy with the 10 real affiliate
-- products. Each gets its own /go/<slug> review landing page. cta_url
-- stays empty until Mayor pastes his approved affiliate link
-- (AFFILIATE-LINK-NEEDED); pages render "coming soon" until then.

-- Retire the generic keys from 0014 (superseded by product slugs).
-- sponsor_sms is renamed to the hyphenated product-slug convention.
DELETE FROM offer_slot WHERE key IN ('resume_service', 'course', 'remote_board', 'bootcamp', 'coaching', 'sponsor_sms');

INSERT OR IGNORE INTO offer_slot (key, name, slot_type, headline, body, cta_text, sms_copy, priority) VALUES
('great-resumes-fast', 'Great Resumes Fast', 'affiliate',
 'Your resume, rewritten by a pro — in days',
 'Certified resume writers rebuild your resume around the jobs you actually want. ATS-proof formatting included.',
 'Get my rewrite',
 'Pro resume rewrite, done in days. See how it works: ', 10),
('myperfectresume', 'MyPerfectResume', 'affiliate',
 'Build a job-winning resume in 15 minutes',
 'Guided builder with recruiter-approved templates, pre-written bullet points, and a matching cover letter.',
 'Build my resume',
 'Build a recruiter-approved resume in 15 minutes: ', 15),
('designlab', 'Designlab', 'affiliate',
 'Mentor-led design courses that get you hired',
 '1-on-1 mentorship, real portfolio projects, and career coaching for designers switching or leveling up.',
 'Explore Designlab',
 'Mentor-led design courses with real portfolio projects: ', 20),
('coursera', 'Coursera Certificates', 'affiliate',
 'Career certificates from Google, Meta & IBM',
 'Job-ready certificates in IT, data, UX, and project management — the exact skills your matches ask for.',
 'Browse certificates',
 'Google & Meta career certificates that hiring managers respect: ', 25),
('udemy', 'Udemy', 'affiliate',
 'Close your skill gap for the price of lunch',
 'Thousands of job-focused courses, most under $20 on sale. Learn the one skill standing between you and the offer.',
 'Find my course',
 'The skill your top jobs want, taught for under $20: ', 30),
('skillshare', 'Skillshare', 'affiliate',
 'Learn the creative skills that get you noticed',
 'Project-based classes in design, video, and freelancing — build portfolio pieces while you learn.',
 'Start learning',
 'Project-based creative classes that build your portfolio: ', 35),
('flexjobs', 'FlexJobs', 'affiliate',
 'Hand-screened remote jobs — zero scams',
 'Every listing vetted by humans. 30,000+ remote, hybrid, and flexible jobs with the scams already removed.',
 'Browse remote jobs',
 'Hand-screened remote jobs, zero scams: ', 40),
('jobtestprep', 'JobTestPrep', 'affiliate',
 'Pass the assessment, land the job',
 'Practice tests for pre-employment assessments, aptitude tests, and interviews at 100+ major employers.',
 'Start practicing',
 'Practice the exact assessment they will give you: ', 45),
('amazon-gear', 'Interview Gear Bundle', 'affiliate',
 'Look the part on interview day',
 'My hand-picked interview kit: webcam, headset, lighting, and the shirt that photographs well on Zoom.',
 'Shop the bundle',
 'The interview kit I recommend — webcam, headset, lighting: ', 50),
('sponsor-sms', 'Sponsored SMS Slot', 'sponsor',
 'Sponsored message',
 'Flat-fee sponsor placement inside SMS sends and emails. Always labeled "Sponsored".',
 'Learn more',
 '', 60);

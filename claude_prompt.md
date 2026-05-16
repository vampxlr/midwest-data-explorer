# Project Context & API Credentials

**API Details:**
- **Client ID:** `349e752ca018b78956267d409f6e663f`
- **Client Secret:** `ee14864254522d297314a268f5267c67`
- **API Documentation URL:** https://help.sportsengine.com/en/articles/8225304-getting-started-with-api

# Objective
Create a dashboard/solution to track and visualize registration data for Midwest 3 on 3 leagues (internally might be referred to as "surveys"). The main focus is generating accurate reports for **daily registrations**, including breakdowns by day, previous days, weeks, and previous months.

# Instructions for AI (Claude)

1. **Data Syncing & Rate Limiting:**
   - **CRITICAL:** Aggregate data SLOWLY. You must not make too many API calls at a time. Throttle the requests to respect API rate limits.
   - Implement a visual **progress bar** during the data synchronization process.
   - **Time constraint:** It is perfectly acceptable if the sync process takes up to 1 hour, as long as it handles the data sync reliably and slowly.

2. **Core Functionality & Reporting:**
   - The primary outcome must be a comprehensive report for daily registrations.
   - The application must allow filtering or grouping the data by the **name of the league** (or "survey").

3. **Data Visualizations:**
   - Once the core data sync is complete, incrementally add visualizations (bar charts and line charts).
   - Use these charts to illustrate the rise and fall of registrations per day.
   - The charts should display both **Total Registrations** and registrations broken down **by Registration Name** (League/Survey).

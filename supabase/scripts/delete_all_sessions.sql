-- Deletes every session for a clean slate. This can't be undone.
-- Categories, nominees, votes and attendee lists go with them through their cascading foreign keys.
delete from sessions;

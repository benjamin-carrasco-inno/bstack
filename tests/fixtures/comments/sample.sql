-- Report query.
SELECT id, -- trailing
       'it''s -- not a comment' AS quote,
       "weird--name"
FROM items
/* multi
   line */
WHERE note <> '/* not */';

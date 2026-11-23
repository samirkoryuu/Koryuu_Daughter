CREATE TABLE groq_key_rotation_state (
  rotation_id INTEGER PRIMARY KEY CHECK (rotation_id = 1),
  next_index INTEGER NOT NULL CHECK (next_index BETWEEN 0 AND 7)
);

INSERT INTO groq_key_rotation_state(rotation_id, next_index) VALUES (1, 0);

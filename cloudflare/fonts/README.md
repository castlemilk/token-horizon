Token Horizon Sans is a static derivative of the repository's Hubot Sans variable
font, licensed under the SIL Open Font License in `TokenHorizonSans-OFL.txt`.
It is renamed to respect the reserved font name. Its regular and semibold
instances use width 100, weights 400/600, and italic 0. Static instances prevent
resvg from using the variable font's extra-light, condensed default axes.

Regenerate with `task web-og-fonts`. FontTools is a temporary build tool;
the application keeps its existing resvg renderer and adds no dependency.

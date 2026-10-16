import type { TourDefinition } from "./feature-tours";

/** Images: describe a picture, pick a look, and find it again later. */
export const IMAGES_TOUR: TourDefinition = {
  id: "images",
  title: "Images",
  description: "Make a picture from a few words, pick a look, and find it again by client or task.",
  version: 1,
  autoStart: false,
  route: { match: /^\/images\/?$/, path: "/images" },
  label: "Images",
  steps: [
    {
      title: "Pictures from plain words",
      body: "Describe the picture you want and GSAM makes it. Your agents can make images for their tasks too, and everything lands here.",
    },
    {
      target: "images-composer",
      title: "Describe it, then pick a look",
      body: "Say what the image should show. Pick a style such as Greatstone brand or Social post and the right wording and shape are added for you. Stuck? Select an idea to start from.",
    },
    {
      target: "images-make",
      title: "Make it",
      body: "Select Make image. It is usually ready in under a minute, and you can leave the page while it works.",
    },
    {
      target: "images-gallery",
      title: "Find it again",
      body: "Search by what the image shows or pick a client. Each image links to the task it was made for. Open one to download it or make another like it.",
    },
    {
      title: "From a task",
      body: "On any task, select Make an image next to Upload attachment. The picture is added to the task when you are happy with it.",
    },
  ],
};

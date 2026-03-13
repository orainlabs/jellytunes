Feature: Navegación de Biblioteca
  Como usuario autenticado
  Quiero navegar por mi biblioteca de música
  Para encontrar y seleccionar contenido para sincronizar

  Background:
    Given el usuario está autenticado en Jellyfin
    And la biblioteca de música está cargada

  Scenario: Visualización de lista de artistas
    Given el usuario está en la pantalla de biblioteca
    When el usuario selecciona la pestaña "Artistas"
    Then debería mostrarse una lista de artistas
    And cada artista debería mostrar su nombre
    And cada artista debería mostrar la cantidad de álbumes

  Scenario: Visualización de álbumes de un artista
    Given el usuario está viendo la lista de artistas
    When el usuario hace click en el artista "The Beatles"
    Then debería mostrarse la vista del artista
    And debería mostrar todos los álbumes del artista
    And debería mostrar información del artista (nombre, biografía si existe)

  Scenario: Visualización de canciones de un álbum
    Given el usuario está viendo los álbumes de "The Beatles"
    When el usuario hace click en el álbum "Abbey Road"
    Then debería mostrarse la lista de canciones del álbum
    And cada canción debería mostrar título, duración y número de pista
    And debería mostrar la portada del álbum

  Scenario: Navegación a playlists
    Given el usuario está en la pantalla de biblioteca
    When el usuario selecciona la pestaña "Playlists"
    Then debería mostrarse una lista de playlists
    And cada playlist debería mostrar su nombre
    And cada playlist debería mostrar la cantidad de canciones

  Scenario: Visualización de canciones de una playlist
    Given el usuario está viendo la lista de playlists
    When el usuario hace click en la playlist "Mis Favoritas"
    Then debería mostrarse la lista de canciones de la playlist
    And debería mostrar el nombre de la playlist
    And debería mostrar el total de duración

  Scenario: Navegación con breadcrumbs
    Given el usuario está viendo las canciones de un álbum
    When el usuario hace click en "Artistas" en el breadcrumb
    Then debería volver a la lista de artistas
    When el usuario hace click en "Biblioteca" en el breadcrumb
    Then debería volver a la vista principal de biblioteca

  Scenario: Scroll infinito en listas largas
    Given la biblioteca tiene más de 50 artistas
    When el usuario está en la pestaña "Artistas"
    Then debería mostrar los primeros 20 artistas
    When el usuario hace scroll hasta el final
    Then debería cargar los siguientes 20 artistas
    And la lista debería mostrar 40 artistas en total